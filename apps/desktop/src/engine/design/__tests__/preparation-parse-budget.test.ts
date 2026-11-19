import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Counts through the real producers: every full parse, and every template
// render and component summary the engine asks for.
const counts = vi.hoisted(() => ({ parses: [] as string[], renders: 0, summaries: [] as string[] }));
vi.mock("parse5", async (importOriginal) => {
  const actual = await importOriginal<typeof import("parse5")>();
  return { ...actual, parse: ((html: string, options?: Parameters<typeof actual.parse>[1]) => {
    counts.parses.push(html);
    return actual.parse(html, options);
  }) as typeof actual.parse };
});
vi.mock("@zeros/design-web/component-template", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@zeros/design-web/component-template")>();
  return { ...actual,
    renderComponentTemplate: ((...args: Parameters<typeof actual.renderComponentTemplate>) => {
      counts.renders++;
      return actual.renderComponentTemplate(...args);
    }) as typeof actual.renderComponentTemplate,
    designComponentSummaryOf: ((...args: Parameters<typeof actual.designComponentSummaryOf>) => {
      counts.summaries.push(args[0]);
      return actual.designComponentSummaryOf(...args);
    }) as typeof actual.designComponentSummaryOf };
});

import { resetDesignComponentRendersForTests } from "../component-last-good";
import { resetDesignComponentDefinitionsForTests } from "../components";
import { designDocumentIdForFrame, getWorkspaceDesignApi, resetWorkspaceDesignApisForTests } from "../design-api";
import { createDesignFrame, DESIGN_DIRECTORY_NAME, lintDesignFramesAtVersions, prepareDesignNavigationFrames, readDesignFrame,
  readDesignFrameRenderSourceFromSource, readDesignNavigationSnapshot } from "../document";
import { readCanvas, writeCanvas } from "../document-storage";
import { resetDesignIdentityCacheForTests } from "../identity-cache";
import { configureDesignPreparationWorkersForTests } from "../preparation-pool";
import { readDesignProtocolResource } from "../protocol-resource";
import { configureSharedDesignParsesForTests } from "../shared-parse";

const main = (marker: string) => '<!doctype html><html><head><title>' + marker + '</title><link rel="stylesheet" href="../tokens.css">\n' +
  '<template data-zd-options>\n<zd-option name="label" type="text" default="Send"></zd-option>\n' +
  '<zd-option name="width" type="number" default="120" unit="px"></zd-option>\n<zd-variant name="big" width="300" label="Big"></zd-variant>\n</template>\n' +
  '<style>.chip { width: var(--zd-width); }</style></head>\n<body><div class="chip hero" data-oid="root"><b data-oid="b">{{ label }}</b></div></body></html>';
const host = (n: number, component: string) => '<!doctype html><html><head><link rel="stylesheet" href="../tokens.css"></head><body><main data-oid="m' + n + '">' +
  '<zd-' + component + ' data-oid="i" label="Host ' + n + '"></zd-' + component + '></main></body></html>';

let root: string;
const directory = () => path.join(root, DESIGN_DIRECTORY_NAME);

/** A main registered as zd-<component>, and host frames placing it. */
async function component(name: string, hosts: number) {
  const created = await createDesignFrame(root, { title: name });
  await writeFile(path.join(directory(), created.file), main("marker-" + name));
  const files: string[] = [];
  for (let index = 0; index < hosts; index++) {
    const frame = await createDesignFrame(root, { title: name + " host " + index });
    await writeFile(path.join(directory(), frame.file), host(index, name));
    files.push(frame.file);
  }
  const canvas = await readCanvas(root);
  canvas.frame_info[created.file] = { ...canvas.frame_info[created.file]!, component: name } as never;
  await writeCanvas(root, canvas);
  return { main: created.file, hosts: files };
}

async function prepare(files: string[]) {
  const navigation = await readDesignNavigationSnapshot(root);
  const prepared = await prepareDesignNavigationFrames(root, navigation.catalogRevision, files);
  expect(prepared.errors).toEqual([]);
  return prepared.frames;
}

const reset = () => { counts.parses.length = 0; counts.renders = 0; counts.summaries.length = 0; };
const parsesOf = (source: string) => counts.parses.filter((html) => html === source).length;
const summariesOf = (source: string) => counts.summaries.filter((html) => html === source).length;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "zeros-parse-budget-"));
  process.env.ZEROS_DATA_DIR = path.join(root, "private");
  configureDesignPreparationWorkersForTests(0);
  await createDesignFrame(root, { title: "Seed" });
  await writeFile(path.join(directory(), "tokens.css"), ".hero { color: red; }");
});
beforeEach(() => {
  resetDesignIdentityCacheForTests();
  resetDesignComponentRendersForTests();
  resetDesignComponentDefinitionsForTests();
  // A stage that writes to a tree another stage shares throws.
  configureSharedDesignParsesForTests({ freeze: true });
});
afterEach(() => configureSharedDesignParsesForTests({}));
afterAll(async () => {
  configureDesignPreparationWorkersForTests(null);
  resetWorkspaceDesignApisForTests();
  delete process.env.ZEROS_DATA_DIR;
  await rm(root, { recursive: true, force: true });
});

describe("Design parse budget", () => {
  it("one apply parses the source at most six times", async () => {
    const { main: file } = await component("apply-chip", 0);
    const before = await readFile(path.join(directory(), file), "utf8");
    const api = getWorkspaceDesignApi(root);
    const opened = await api.open(designDocumentIdForFrame(file));
    reset();
    const result = await api.apply({ schemaVersion: 1, transactionId: "t-budget", documentId: opened.documentId, baseRevision: opened.revision,
      actor: { kind: "human", id: "desktop" }, intent: "Set width", createdAt: 1,
      operations: [{ operationId: "o1", type: "component.set-option", file, option: "width", variant: null, value: 140 }] } as never);
    expect(result.receipt.status).toBe("applied");
    const after = await readFile(path.join(directory(), file), "utf8");
    expect(after).not.toBe(before);
    // The engine reads the document before and after the commit once each per
    // repository call; design-web's own diagnostics and option edit add three.
    expect(parsesOf(before) + parsesOf(after)).toBeLessThanOrEqual(6);
  });

  it("N host frames expand one main definition once", async () => {
    const { main: file, hosts } = await component("hosted-chip", 6);
    const source = await readFile(path.join(directory(), file), "utf8");
    reset();
    const frames = await prepare(hosts);
    expect(frames).toHaveLength(6);
    for (const frame of frames) expect(frame.instances?.hosts.i?.component).toBe("hosted-chip");
    // One definition parse and one summary (itself two parses), whatever N is.
    expect(summariesOf(source)).toBe(1);
    expect(parsesOf(source)).toBe(3);
    // Each host still renders its own instance.
    expect(counts.renders).toBe(6);
  });

  it("a host prepared from a remembered definition renders as one prepared from source", async () => {
    const { hosts } = await component("remembered-chip", 2);
    const first = await prepare(hosts);
    const documents = await Promise.all(hosts.map((file) => readDesignFrame(root, file)));
    resetDesignIdentityCacheForTests();
    const again = await prepare(hosts);
    expect(again.map(({ modifiedAt: _m, ...frame }) => frame)).toEqual(first.map(({ modifiedAt: _m, ...frame }) => frame));
    const rereads = await Promise.all(hosts.map((file) => readDesignFrame(root, file)));
    expect(rereads.map(({ srcDoc, sourceVersion }) => ({ srcDoc, sourceVersion })))
      .toEqual(documents.map(({ srcDoc, sourceVersion }) => ({ srcDoc, sourceVersion })));
  });

  it("a variant render calls the template renderer once, under the source's generation", async () => {
    const { main: file } = await component("variant-chip", 0);
    const [prepared] = await prepare([file]);
    const plain = await readDesignFrame(root, file);
    expect(plain.sourceVersion).toBe(prepared!.sourceVersion);
    reset();
    const variant = await readDesignFrame(root, file, 4, { variant: "big" });
    expect(counts.renders).toBe(1);
    expect(variant.sourceVersion).toBe(plain.sourceVersion);
    expect(variant.srcDoc).toContain("Big");
    expect(variant.srcDoc).not.toBe(plain.srcDoc);

    reset();
    const served = await readDesignProtocolResource(root, { path: file, sourceVersion: plain.sourceVersion, variant: "big" });
    expect(served.status).toBe(200);
    expect(counts.renders).toBe(1);
    expect(served.body.toString("utf8")).toContain("Big");
  });

  it("a variant read with nothing prepared renders the same document under the same generation", async () => {
    const { main: file } = await component("cold-variant-chip", 0);
    await prepare([file]);
    const warm = await readDesignFrame(root, file, 4, { variant: "big" });
    const warmServed = await readDesignProtocolResource(root, { path: file, sourceVersion: warm.sourceVersion, variant: "big" });
    resetDesignIdentityCacheForTests();
    const cold = await readDesignProtocolResource(root, { path: file, sourceVersion: warm.sourceVersion, variant: "big" });
    expect(cold.status).toBe(200);
    expect(cold.body.equals(warmServed.body)).toBe(true);
    resetDesignIdentityCacheForTests();
    const coldRead = await readDesignFrame(root, file, 4, { variant: "big" });
    expect({ srcDoc: coldRead.srcDoc, sourceVersion: coldRead.sourceVersion }).toEqual({ srcDoc: warm.srcDoc, sourceVersion: warm.sourceVersion });
  });

  it("a source lint parses each frame's source once besides the main's own template reads", async () => {
    const { main: file, hosts } = await component("linted-chip", 3);
    const files = [file, ...hosts];
    const directoryFile = (name: string) => readFile(path.join(directory(), name), "utf8");
    const mainSource = await directoryFile(file);
    const hostSources = await Promise.all(hosts.map(directoryFile));
    const frames = await prepare(files);
    const navigation = await readDesignNavigationSnapshot(root);
    const lintPrepared = () => prepareDesignNavigationFrames(root, navigation.catalogRevision, files, undefined, { lintFiles: files });
    const lintAtVersions = () => lintDesignFramesAtVersions(root, navigation.directoryId!,
      frames.map((frame) => ({ file: frame.file, sourceVersion: frame.sourceVersion! })));

    configureSharedDesignParsesForTests({ disabled: true });
    const unshared = { prepared: (await lintPrepared()).lint, atVersions: await lintAtVersions() };
    configureSharedDesignParsesForTests({ freeze: true });

    for (const [path, run] of [["prepared", lintPrepared], ["at versions", lintAtVersions]] as const) {
      reset();
      const report = await run();
      expect(path === "prepared" ? (report as Awaited<ReturnType<typeof lintPrepared>>).lint : report)
        .toEqual(path === "prepared" ? unshared.prepared : unshared.atVersions);
      // The lint's own located parse serves its component expansion; the
      // main's template render and summary parse inside design-web.
      for (const source of hostSources) expect(parsesOf(source), path).toBe(1);
      expect(parsesOf(mainSource), path).toBe(4);
      // Version checks around the lint reuse prepared identities: only the
      // lint's own expansion renders, once per frame.
      expect(counts.renders, path).toBe(4);
    }
  });

  it("a variant of bytes other than the prepared ones carries their own generation", async () => {
    const { main: file } = await component("edited-variant-chip", 0);
    const [prepared] = await prepare([file]);
    const edited = (await readFile(path.join(directory(), file), "utf8")).replace('default="Send"', 'default="Post"');
    const plain = await readDesignFrameRenderSourceFromSource(root, file, edited);
    expect(plain.sourceVersion).not.toBe(prepared!.sourceVersion);
    const variant = await readDesignFrameRenderSourceFromSource(root, file, edited, undefined, "big");
    expect(variant.sourceVersion).toBe(plain.sourceVersion);
  });
});
