import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "parse5";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { expandDesignComponents, expandDesignComponentsHtml } from "../components";
import {
  DESIGN_DIRECTORY_NAME,
  initializeDesignDocument,
  prepareDesignNavigationFrames,
  readDesignNavigationSnapshot,
} from "../document";
import { readCanvas } from "../document-storage";
import { composeFrameSrcDoc, prepareFrameRenderSource, resetDesignStylesheetCacheForTests } from "../render-preparation";
import { applyDesignSourceEdits, elementRecords, explicitDesignHeadEnd, insertDesignHeadMarkup } from "../source";
import {
  configureSharedDesignParsesForTests,
  parseDesignSource,
  sharedDesignParse,
  sharedDesignParseStatsForTests,
  withSharedDesignParses,
} from "../shared-parse";

// A 1x1 transparent PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);
const viewport = { width: 320, height: 240 };
const CLEAN =
  '<!doctype html><html><head><link rel="stylesheet" href="../tokens.css"></head><body><main data-oid="m"><h1 data-oid="t">Hi</h1></main></body></html>';
/** Each frame makes a different stage edit its text, so a stage that read a
 * stale or mutated shared tree would change the bytes it produces. */
const FRAMES: Record<string, string> = {
  clean: CLEAN,
  "missing-oids":
    '<!doctype html><html><head><link rel="stylesheet" href="../tokens.css"></head><body><main><h1>Hi</h1><p data-oid="p">a</p><p data-oid="p">dup</p><p data-oid>bare</p></main></body></html>',
  assets:
    '<!doctype html><html><head></head><body><main data-oid="m"><img data-oid="i" src="../assets/dot.png" srcset="../assets/dot.png 2x"><div data-oid="d" style="background:url(../assets/dot.png)"></div><style>.x{background:url(../assets/dot.png)}</style></main></body></html>',
  active:
    '<!doctype html><html><head><meta http-equiv="refresh" content="0"><base href="x"><script>alert(1)</script></head><body onload="x()"><main data-oid="m"><a data-oid="a" href="javascript:alert(1)" onclick="y()">x</a><svg data-oid="s"><a xlink:href="javascript:alert(1)">z</a><link rel="stylesheet" href="../tokens.css"></svg><iframe srcdoc="<p>x</p>"></iframe><object data="x"><p>inner</p></object></main></body></html>',
  "legacy-oids":
    '<!doctype html><html data-oid="h"><head data-oid="hd"><style data-oid="st">.a{color:red}</style></head><body data-oid="b"><main data-oid="m" data-zeros-frame-root>Hi</main></body></html>',
  shadow:
    '<!doctype html><html><head></head><body><main data-oid="m"><div data-oid="host"><template shadowrootmode="open"><link rel="stylesheet" href="../tokens.css"><span data-oid="in">x</span><slot></slot></template><b data-oid="slotted">y</b></div></main></body></html>',
  components:
    '<!doctype html><html><head></head><body><main data-oid="m"><zd-card data-oid="c">Body</zd-card><ZD-CARD data-oid="c2"></ZD-CARD></main></body></html>',
  "component-text":
    '<!doctype html><html><head><script>"<zd-card>"</script></head><body><!-- <zd-card> --><main data-oid="m">&lt;zd-card&gt;</main></body></html>',
  implicit: '<link rel="stylesheet" href="../tokens.css"><p>no head or body</p>',
  "link-before-head":
    '<!doctype html><link rel="stylesheet" href="../tokens.css"><head><title>t</title></head><body><main data-oid="m">x</main></body>',
  "remote-link-before-head":
    '<!doctype html><link rel="stylesheet" href="https://example.com/x.css"><head><title>t</title></head><body><main data-oid="m">x</main></body>',
  "link-in-table":
    '<!doctype html><html><head></head><body><main data-oid="m"><table data-oid="tb"><link rel="stylesheet" href="../tokens.css"><tr><td>x</td></tr></table></main></body></html>',
};

describe("shared frame parses", () => {
  let root: string;
  let folder: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "zeros-shared-parse-"));
    process.env.ZEROS_DATA_DIR = path.join(root, "private");
    folder = path.join(root, DESIGN_DIRECTORY_NAME);
    await initializeDesignDocument(root);
    await mkdir(path.join(folder, "assets"), { recursive: true });
    await mkdir(path.join(folder, "components"), { recursive: true });
    await mkdir(path.join(folder, "page-1"), { recursive: true });
    await mkdir(path.join(root, "styles"), { recursive: true });
    await writeFile(path.join(folder, "assets/dot.png"), PNG);
    await writeFile(path.join(folder, "tokens.css"), ":root { --gap: 4px; } .hero { background: url(assets/dot.png); }");
    await writeFile(
      path.join(folder, "components/card.html"),
      '<!doctype html><html><head><style>.card { padding: 4px; }</style></head><body><article class="card"><slot></slot></article></body></html>',
    );
    await writeFile(path.join(root, "styles/app.css"), ":root { --brand: 1px; } .h1 { color: red; }");
    const file = path.join(folder, "meta/canvas.json");
    const canvas = JSON.parse(await readFile(file, "utf8"));
    canvas.styles = [{ id: "app", title: "App", kind: "css", path: "styles/app.css" }];
    for (const [index, [name, html]] of Object.entries(FRAMES).entries()) {
      await writeFile(path.join(folder, `page-1/${name}.html`), html);
      canvas.frames[`frame_${index}`] = {
        kind: "html", source: `page-1/${name}.html`, title: name, x: index * 400, y: 0, width: 320, height: 240,
      };
      canvas.pages[0].frames.push(`frame_${index}`);
    }
    await writeFile(file, JSON.stringify(canvas, null, 2));
  });
  afterEach(() => configureSharedDesignParsesForTests({}));
  afterAll(async () => {
    delete process.env.ZEROS_DATA_DIR;
    await rm(root, { recursive: true, force: true });
  });

  async function renders(name: string) {
    const entry = `page-1/${name}.html`;
    const canvas = await readCanvas(root);
    resetDesignStylesheetCacheForTests();
    return {
      identity: await prepareFrameRenderSource(root, FRAMES[name]!, viewport, undefined, undefined, entry, canvas, { identityOnly: true }),
      full: await prepareFrameRenderSource(root, FRAMES[name]!, viewport, undefined, undefined, entry, canvas),
      document: await composeFrameSrcDoc(root, FRAMES[name]!, viewport, entry),
    };
  }

  it("renders every frame byte for byte as unshared parsing does, and no stage writes to a shared tree", async () => {
    for (const name of Object.keys(FRAMES)) {
      configureSharedDesignParsesForTests({ disabled: true });
      const unshared = await renders(name);
      configureSharedDesignParsesForTests({ freeze: true });
      expect(await renders(name), name).toEqual(unshared);
    }
    const active = (await renders("active")).full.sanitized;
    expect(active).not.toMatch(/alert|onclick|onload|<script|<iframe|<object|refresh/);
    const components = (await renders("components")).full.sanitized;
    expect(components).toContain('<article class="card">');
    expect((await renders("legacy-oids")).full.sanitized).not.toContain('data-oid="hd"');
  });

  it("prepares a page's frames identically, each in its own scope", async () => {
    const navigation = await readDesignNavigationSnapshot(root);
    const files = navigation.snapshot.pages![0]!.frameFiles;
    const prepare = async () => {
      const prepared = await prepareDesignNavigationFrames(root, navigation.catalogRevision, files);
      return { ...prepared, frames: prepared.frames.map(({ modifiedAt: _modifiedAt, ...frame }) => frame) };
    };
    configureSharedDesignParsesForTests({ disabled: true });
    const unshared = await prepare();
    configureSharedDesignParsesForTests({ freeze: true });
    expect(await prepare()).toEqual(unshared);
    expect(unshared.frames).toHaveLength(files.length);
    expect(unshared.frames.every((frame) => frame.pageId === navigation.snapshot.pages![0]!.id)).toBe(true);
  });

  it("parses each distinct text of a clean frame once", async () => {
    const canvas = await readCanvas(root);
    const prepare = () => prepareFrameRenderSource(root, CLEAN, viewport, undefined, undefined, "page-1/clean.html", canvas, { identityOnly: true });
    await prepare();
    configureSharedDesignParsesForTests({ disabled: true });
    let before = sharedDesignParseStatsForTests();
    await prepare();
    // Heal, link, inline, sanitize and strip each parse; the head insert reuses the link parse.
    expect(sharedDesignParseStatsForTests().parses - before.parses).toBe(5);
    configureSharedDesignParsesForTests({});
    before = sharedDesignParseStatsForTests();
    await prepare();
    const after = sharedDesignParseStatsForTests();
    // Linking reads the healed text, and sanitize and strip read the inlined text unchanged.
    expect(after.parses - before.parses).toBe(2);
    expect(after.shared - before.shared).toBe(3);
  });

  it("puts head markup where a fresh parse would after any edit that follows an explicit head tag", () => {
    const markup = '<style data-zeros-style-source="app"></style>';
    const documents = [
      ...Object.values(FRAMES),
      '<!doctype html><html><head><title>t</title><link rel=stylesheet href=a.css></head><body><link rel=stylesheet href=b.css></body></html>',
      '<!doctype html><!--c--><html lang="en"><!--d--><head data-x="1"><meta charset="utf-8"><link rel="stylesheet" href="a.css"></head></html>',
      '<!DOCTYPE html><HEAD><LINK REL=STYLESHEET HREF=a.css></HEAD><body><svg><head></head></svg></body>',
      '<!doctype html><html><head ><link rel="stylesheet" href="a.css"/></head>',
    ];
    let explicit = 0;
    for (const source of documents) {
      const document = parse(source, { sourceCodeLocationInfo: true });
      const end = explicitDesignHeadEnd(document);
      if (end === undefined) continue;
      explicit++;
      const after = elementRecords(document).map(({ element }) => element.sourceCodeLocation!)
        .filter((location) => location && location.startOffset >= end);
      for (const text of ['<style data-zeros-sheet="0-x"></style>', "", "<p>moved</p>", "</head><body><head>", "<!--"]) {
        for (const edits of [after.slice(0, 1), after].map((locations) =>
          locations.map((location) => ({ start: location.startOffset, end: location.startTag?.endOffset ?? location.endOffset, text })))) {
          const edited = applyDesignSourceEdits(source, edits);
          expect(`${edited.slice(0, end)}${markup}${edited.slice(end)}`, source).toBe(insertDesignHeadMarkup(edited, markup));
        }
      }
    }
    expect(explicit).toBeGreaterThanOrEqual(10);
    for (const name of ["implicit", "link-before-head", "remote-link-before-head"])
      expect(explicitDesignHeadEnd(parse(FRAMES[name]!, { sourceCodeLocationInfo: true })), name).toBeUndefined();
  });

  it("shares trees only inside a scope, never across concurrent scopes, and not for large text", async () => {
    expect(parseDesignSource(CLEAN)).not.toBe(parseDesignSource(CLEAN));
    expect(sharedDesignParse(CLEAN)).toBeUndefined();
    const [first, second] = await Promise.all([0, 1].map(() => withSharedDesignParses(async () => {
      const document = parseDesignSource(CLEAN);
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(parseDesignSource(CLEAN)).toBe(document);
      expect(sharedDesignParse(CLEAN)).toBe(document);
      expect(await withSharedDesignParses(async () => parseDesignSource(CLEAN))).toBe(document);
      return document;
    })));
    expect(first).not.toBe(second);
    configureSharedDesignParsesForTests({ freeze: true });
    await withSharedDesignParses(async () => {
      const document = parseDesignSource(CLEAN);
      expect(() => (document.childNodes as unknown[]).push(null)).toThrow(TypeError);
    });
    const large = `<p>${"x".repeat(1024 * 1024)}</p>`;
    await withSharedDesignParses(async () => {
      expect(parseDesignSource(large)).not.toBe(parseDesignSource(large));
    });
  });

  it("expands markup exactly as full expansion does, skipping parses only without a component tag", async () => {
    const sources = [
      FRAMES.clean!,
      FRAMES.components!,
      FRAMES["component-text"]!,
      // Full expansion reports the element budget; the markup stays the source.
      `<!doctype html><html><body>${"<i></i>".repeat(50_000)}</body></html>`,
      // Over the expansion limit, full expansion renders nothing.
      `<!doctype html><html><body>${"<p>x</p>".repeat(300_000)}</body></html>`,
    ];
    for (const source of sources) {
      const expanded = await expandDesignComponents(root, source, undefined, "page-1/x.html");
      expect(await expandDesignComponentsHtml(root, source, undefined, "page-1/x.html")).toBe(expanded.html);
    }
    expect((await expandDesignComponents(root, sources[3]!)).errors).toHaveLength(1);
    expect(await expandDesignComponentsHtml(root, sources[4]!)).toBe("");
  });
});
