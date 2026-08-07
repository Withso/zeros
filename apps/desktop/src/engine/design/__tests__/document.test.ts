import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createDesignFrame,
  deleteDesignFrame,
  DESIGN_DIRECTORY_NAME,
  duplicateDesignFrame,
  healDesignOids,
  initializeDesignDocument,
  insertDesignAsset,
  lintDesignDocument,
  listDesignAssets,
  listDesignFrames,
  readDesignElementOffsetMap,
  readDesignFrame,
  readDesignFrameRenderIdentity,
  readDesignWorkspaceSnapshot,
  readDesignTokens,
  readDesignTokensDocument,
  renameDesignFrame,
  setDesignNodeText,
  updateDesignFrameGeometry,
  updateDesignNodeStyles,
  updateDesignToken,
  writeDesignNodeHtml,
} from "../document";
import { withDesignDocumentWrite } from "../document-write-lock";
import {
  resetDesignRuntimeAuditsForTests,
  setDesignRuntimeAudit,
} from "../runtime-audits";

describe("design document", () => {
  let root: string;

  beforeEach(async () => {
    resetDesignRuntimeAuditsForTests();
    root = await mkdtemp(path.join(tmpdir(), "zeros-design-document-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("seeds the portable HTML/CSS document and discovers stable frame geometry", async () => {
    const result = await initializeDesignDocument(root);
    expect(result.created).toEqual(
      expect.arrayContaining([
        `${DESIGN_DIRECTORY_NAME}/tokens.css`,
        `${DESIGN_DIRECTORY_NAME}/.zeros-canvas.json`,
      ]),
    );
    const canvasSeed = JSON.parse(
      await readFile(
        path.join(root, DESIGN_DIRECTORY_NAME, ".zeros-canvas.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(canvasSeed).toMatchObject({
      version: 2,
      foundation: {
        schemaVersion: 1,
        parameters: [],
        variants: [],
        components: [],
      },
    });

    const created = await createDesignFrame(root, { title: "Landing page" });
    expect(created.file).toBe("landing-page.html");
    const source = await readFile(
      path.join(root, DESIGN_DIRECTORY_NAME, created.file),
      "utf8",
    );
    expect(source).toContain('name="zeros-frame"');
    expect(source).toContain('href="./tokens.css"');
    expect(source).not.toContain("<script");
    expect(source).toContain("Shape this frame with the canvas and inspector.");
    expect(source).not.toMatch(/\bchat\b/i);
    expect(source).not.toMatch(
      /<(?:html|head|meta|link|title|style|body)\b[^>]*\bdata-oid=/i,
    );
    const tokens = await readFile(
      path.join(root, DESIGN_DIRECTORY_NAME, "tokens.css"),
      "utf8",
    );
    expect(tokens).toContain("body [data-oid]");
    expect(tokens).not.toMatch(/^\s*\[data-oid\]/m);

    await updateDesignFrameGeometry(root, created.file, {
      x: 240,
      y: 80,
      w: 1280,
      h: 720,
      z: 3,
    });
    const frames = await listDesignFrames(root);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      file: created.file,
      title: "Landing page",
      x: 240,
      y: 80,
      width: 1280,
      height: 720,
      z: 3,
    });
  });

  it("migrates version-1 canvas metadata forward without losing geometry", async () => {
    await initializeDesignDocument(root);
    const directory = path.join(root, DESIGN_DIRECTORY_NAME);
    await writeFile(
      path.join(directory, "legacy.html"),
      '<!doctype html><html><head><meta name="zeros-frame" content="title=Legacy"></head><body><main data-oid="legacy">Legacy</main></body></html>',
      "utf8",
    );
    await writeFile(
      path.join(directory, ".zeros-canvas.json"),
      `${JSON.stringify({
        version: 1,
        frames: {
          "legacy.html": { x: 40, y: 50, w: 800, h: 600, z: 2 },
        },
      })}\n`,
      "utf8",
    );

    await updateDesignFrameGeometry(root, "legacy.html", { x: 75 });
    const migrated = JSON.parse(
      await readFile(path.join(directory, ".zeros-canvas.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(migrated).toMatchObject({
      version: 2,
      frames: {
        "legacy.html": { x: 75, y: 50, w: 800, h: 600, z: 2 },
      },
      foundation: { schemaVersion: 1 },
    });
  });

  it.each(["3", null])(
    "fails closed for a non-numeric canvas version (%j)",
    async (version) => {
      await initializeDesignDocument(root);
      const target = path.join(
        root,
        DESIGN_DIRECTORY_NAME,
        ".zeros-canvas.json",
      );
      const unsupported = `${JSON.stringify({ version, frames: {} })}\n`;
      await writeFile(target, unsupported, "utf8");

      await expect(readDesignWorkspaceSnapshot(root)).rejects.toThrow(
        "Unsupported design canvas version",
      );
      expect(await readFile(target, "utf8")).toBe(unsupported);
    },
  );

  it("heals missing and duplicate data-oid values without rewriting the document", () => {
    const source =
      '<!doctype html><html><body><main data-oid="same"><h1>Hello</h1><p data-oid="same">World</p></main></body></html>';
    const healed = healDesignOids(source);

    expect(healed.changed).toBe(true);
    expect(healed.fixed.filter((fix) => fix.kind === "missing")).toHaveLength(
      1,
    );
    expect(healed.fixed.filter((fix) => fix.kind === "duplicate")).toHaveLength(
      1,
    );
    expect(healed.html).toContain("<h1 data-oid=");
    const ids = [...healed.html.matchAll(/data-oid="([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(healed.html.replace(/ data-oid="[^"]+"/g, "")).toBe(
      source.replace(/ data-oid="[^"]+"/g, ""),
    );
  });

  it("numbers generated oid collisions from the stable base", () => {
    const template =
      '<!doctype html><html><body><div data-oid="aaaaaaaaaaa"></div><div data-oid="aaaaaaaaaaa-2"></div><h1>Target</h1></body></html>';
    const generated = [
      ...healDesignOids(template).html.matchAll(/data-oid="([^"]+)"/g),
    ][2]?.[1];
    expect(generated).toMatch(/^o-[a-f0-9]{9}$/);

    const collisionSource = template
      .replace("aaaaaaaaaaa", generated!)
      .replace("aaaaaaaaaaa-2", `${generated!}-2`);
    const healed = healDesignOids(collisionSource);
    const ids = [...healed.html.matchAll(/data-oid="([^"]+)"/g)].map(
      (match) => match[1],
    );

    expect(ids[2]).toBe(`${generated}-3`);
  });

  it("heals an unquoted duplicate data-oid once and stays idempotent", () => {
    const source =
      "<!doctype html><html><body><main data-oid=shared><p data-oid=shared>Copy</p></main></body></html>";

    const healed = healDesignOids(source);
    const ids = [...healed.html.matchAll(/data-oid=([^\s>]+)/g)].map((match) =>
      match[1]?.replace(/["']/g, ""),
    );

    expect(healed.changed).toBe(true);
    expect(new Set(ids).size).toBe(2);
    expect(healDesignOids(healed.html)).toMatchObject({
      html: healed.html,
      changed: false,
      fixed: [],
    });
  });

  it("rewrites a blank data-oid in place and stays idempotent", () => {
    const source =
      '<!doctype html><html><body><div data-oid></div><span data-oid="   ">Copy</span></body></html>';

    const first = healDesignOids(source);
    const second = healDesignOids(first.html);

    expect(first.changed).toBe(true);
    expect(first.fixed).toEqual([
      expect.objectContaining({ kind: "missing" }),
      expect.objectContaining({ kind: "missing" }),
    ]);
    expect(first.html.match(/\bdata-oid\b/g)).toHaveLength(2);
    expect(first.html).not.toMatch(/data-oid(?:\s|>)/);
    expect(second).toEqual({ html: first.html, changed: false, fixed: [] });
  });

  it("reports a blank data-oid exactly once before healing", async () => {
    await initializeDesignDocument(root);
    const target = path.join(root, DESIGN_DIRECTORY_NAME, "blank-oid.html");
    await writeFile(
      target,
      "<!doctype html><html><body><div data-oid></div></body></html>",
      "utf8",
    );

    const report = await lintDesignDocument(root, "blank-oid.html", {
      healOids: false,
    });

    expect(
      report.violations.filter((violation) =>
        ["oid-missing", "oid-duplicate"].includes(violation.ruleId),
      ),
    ).toEqual([
      expect.objectContaining({
        ruleId: "oid-missing",
        message: "<div> is missing a stable data-oid.",
      }),
    ]);
  });

  it("returns post-heal oid lint while preserving the healed count", async () => {
    await initializeDesignDocument(root);
    const target = path.join(root, DESIGN_DIRECTORY_NAME, "healed-report.html");
    await writeFile(
      target,
      '<!doctype html><html><body><main data-oid="same"><h1>Missing</h1><p data-oid="same">Duplicate</p></main></body></html>',
      "utf8",
    );

    const before = await lintDesignDocument(root, "healed-report.html", {
      healOids: false,
    });
    expect(
      before.violations.filter((violation) =>
        ["oid-missing", "oid-duplicate"].includes(violation.ruleId),
      ),
    ).toHaveLength(2);

    const after = await lintDesignDocument(root, "healed-report.html");
    expect(after.healedOids).toBe(2);
    expect(
      after.violations.filter((violation) =>
        ["oid-missing", "oid-duplicate"].includes(violation.ruleId),
      ),
    ).toEqual([]);
  });

  it("requires stable ids only on rendered elements inside the body", async () => {
    await initializeDesignDocument(root);
    await writeFile(
      path.join(root, DESIGN_DIRECTORY_NAME, "visual-nodes.html"),
      `<!doctype html>
<html>
  <head>
    <meta name="zeros-frame" content="title=Visual nodes">
    <style>main { display: flex; }</style>
  </head>
  <body>
    <main data-oid="main"><h1>Heading</h1></main>
  </body>
</html>`,
      "utf8",
    );

    const report = await lintDesignDocument(root, "visual-nodes.html", {
      healOids: false,
    });
    const missing = report.violations.filter(
      (violation) => violation.ruleId === "oid-missing",
    );

    expect(missing).toEqual([
      expect.objectContaining({
        message: "<h1> is missing a stable data-oid.",
        line: 8,
      }),
    ]);
  });

  it("reports stable safety and token rule ids with useful locations", async () => {
    await initializeDesignDocument(root);
    await writeFile(
      path.join(root, DESIGN_DIRECTORY_NAME, "unsafe.html"),
      `<!doctype html>
<html>
  <head><link rel="stylesheet" href="https://cdn.example.com/a.css"></head>
  <body data-oid="body"><button data-oid="button" onclick="go()" style="color:var(--not-real)">Go</button><script>go()</script></body>
</html>`,
      "utf8",
    );

    const report = await lintDesignDocument(root, "unsafe.html", {
      healOids: false,
    });
    const ids = report.violations.map((violation) => violation.ruleId);
    expect(ids).toEqual(
      expect.arrayContaining([
        "no-script",
        "no-event-handlers",
        "local-refs-only",
        "no-external-url",
        "unknown-token",
      ]),
    );
    expect(report.violations.every((violation) => violation.line >= 1)).toBe(
      true,
    );
    expect(
      report.violations.find(
        (violation) => violation.ruleId === "unknown-token",
      )?.severity,
    ).toBe("warning");
  });

  it("accepts frame-local custom properties and advises only truly unknown tokens", async () => {
    await initializeDesignDocument(root);
    await writeFile(
      path.join(root, DESIGN_DIRECTORY_NAME, "local-tokens.html"),
      `<!doctype html><html><head><style>:root { --frame-accent: rebeccapurple; }</style></head>
<body><main data-oid="main" style="color:var(--frame-accent); border-color:var(--missing-accent)">Local</main></body></html>`,
      "utf8",
    );

    const report = await lintDesignDocument(root, "local-tokens.html", {
      healOids: false,
    });
    const unknown = report.violations.filter(
      (violation) => violation.ruleId === "unknown-token",
    );

    expect(unknown).toEqual([
      expect.objectContaining({
        severity: "warning",
        message: expect.stringContaining("--missing-accent"),
      }),
    ]);
  });

  it("rejects unsafe, cyclic, and symlinked component definitions", async () => {
    await initializeDesignDocument(root);
    const components = path.join(root, DESIGN_DIRECTORY_NAME, "components");
    await mkdir(components, { recursive: true });
    await writeFile(
      path.join(components, "card.html"),
      "<!doctype html><html><body><article><script>bad()</script><zd-card></zd-card></article></body></html>",
    );
    const outside = path.join(root, "escape.html");
    await writeFile(
      outside,
      "<!doctype html><html><body><p>Outside</p></body></html>",
    );
    await symlink(outside, path.join(components, "escape.html"));
    const frame = await createDesignFrame(root, { title: "Components" });
    const target = path.join(root, DESIGN_DIRECTORY_NAME, frame.file);
    await writeFile(
      target,
      (await readFile(target, "utf8")).replace(
        "</main>",
        '<zd-card data-oid="card"></zd-card><zd-escape data-oid="escape"></zd-escape></main>',
      ),
    );

    const report = await lintDesignDocument(root, frame.file, {
      healOids: false,
    });

    expect(
      report.violations.filter(
        (violation) => violation.ruleId === "component-invalid",
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringMatching(/HTML and CSS only/),
        }),
        expect.objectContaining({
          message: expect.stringMatching(/cycle|depth/i),
        }),
      ]),
    );
    expect(report.violations).toContainEqual(
      expect.objectContaining({
        ruleId: "component-undefined",
        oid: "escape",
      }),
    );
  });

  it("keeps legacy component definitions without data-zid saveable", async () => {
    await initializeDesignDocument(root);
    const components = path.join(root, DESIGN_DIRECTORY_NAME, "components");
    await writeFile(
      path.join(components, "legacy-card.html"),
      "<!doctype html><html><body><article><span>Legacy</span></article></body></html>",
      "utf8",
    );
    const frame = await createDesignFrame(root, { title: "Legacy component" });
    const target = path.join(root, DESIGN_DIRECTORY_NAME, frame.file);
    await writeFile(
      target,
      (await readFile(target, "utf8")).replace(
        "</main>",
        '<zd-legacy-card data-oid="legacy-card"></zd-legacy-card></main>',
      ),
      "utf8",
    );

    const report = await lintDesignDocument(root, frame.file, {
      healOids: false,
    });

    expect(
      report.violations.filter(
        (violation) => violation.ruleId === "component-invalid",
      ),
    ).toEqual([]);
  });

  it("merges only exact-generation runtime lint warnings", async () => {
    await initializeDesignDocument(root);
    const frame = await createDesignFrame(root, { title: "Audit" });
    const identity = await readDesignFrameRenderIdentity(root, frame.file);
    setDesignRuntimeAudit({
      workspacePath: root,
      frame: frame.file,
      sourceVersion: identity.sourceVersion,
      warnings: [
        {
          ruleId: "contrast",
          severity: "warning",
          message: "Text contrast is 2.0:1.",
          file: frame.file,
          line: 8,
          column: 5,
          oid: "heading",
          fix: "Increase contrast.",
        },
      ],
    });
    expect(
      (await lintDesignDocument(root, frame.file)).violations.map(
        (violation) => violation.ruleId,
      ),
    ).toContain("contrast");
    expect(
      (await readDesignWorkspaceSnapshot(root)).lint.violations.map(
        (violation) => violation.ruleId,
      ),
    ).toContain("contrast");

    const target = path.join(root, DESIGN_DIRECTORY_NAME, frame.file);
    await writeFile(
      target,
      `${await readFile(target, "utf8")}\n<!-- changed -->\n`,
    );
    expect(
      (await lintDesignDocument(root, frame.file)).violations.map(
        (violation) => violation.ruleId,
      ),
    ).not.toContain("contrast");
  });

  it("parses typed tokens and counts their use across frames and stylesheets", async () => {
    await initializeDesignDocument(root);
    await mkdir(path.join(root, DESIGN_DIRECTORY_NAME, "assets"), {
      recursive: true,
    });
    await writeFile(
      path.join(root, DESIGN_DIRECTORY_NAME, "one.html"),
      '<!doctype html><html><body data-oid="body" style="color:var(--fg1); background:var(--bg1)"></body></html>',
      "utf8",
    );
    const tokens = await readDesignTokens(root);
    expect(tokens.find((token) => token.name === "--fg1")).toMatchObject({
      syntax: "<color>",
      usageCount: 2,
    });
    expect(tokens.find((token) => token.name === "--bg1")?.usageCount).toBe(2);
  });

  it("round-trips base and per-theme token values with an exact generation", async () => {
    await initializeDesignDocument(root);
    const tokenPath = path.join(root, DESIGN_DIRECTORY_NAME, "tokens.css");
    await writeFile(
      tokenPath,
      `${await readFile(tokenPath, "utf8")}\n[data-zd-theme="dark"] {\n  --bg1: midnightblue;\n}\n`,
    );
    const before = await readDesignTokensDocument(root);
    expect(before.themes).toEqual(["dark"]);
    expect(before.tokens.find((token) => token.name === "--bg1")).toMatchObject(
      {
        value: expect.stringMatching(/^#[0-9a-f]{6}$/i),
        themeValues: { dark: "midnightblue" },
      },
    );

    const updated = await updateDesignToken(root, {
      name: "--bg1",
      theme: "dark",
      value: "darkslategray",
      sourceVersion: before.sourceVersion,
    });
    expect(updated.changed).toBe(true);
    expect(updated.document.sourceVersion).not.toBe(before.sourceVersion);
    expect(
      updated.document.tokens.find((token) => token.name === "--bg1")
        ?.themeValues.dark,
    ).toBe("darkslategray");
    expect(await readFile(tokenPath, "utf8")).toContain(
      "  --bg1: darkslategray;",
    );

    await expect(
      updateDesignToken(root, {
        name: "--bg1",
        theme: null,
        value: "white",
        sourceVersion: before.sourceVersion,
      }),
    ).rejects.toThrow(/changed before/i);
  });

  it("returns one aggregate renderer snapshot and renames a frame by targeted splices", async () => {
    await initializeDesignDocument(root);
    const created = await createDesignFrame(root, { title: "Pricing" });

    const renamed = await renameDesignFrame(
      root,
      created.file,
      "Pricing $& plans",
    );
    expect(renamed.title).toBe("Pricing $& plans");

    const snapshot = await readDesignWorkspaceSnapshot(root);
    expect(snapshot.frames).toHaveLength(1);
    expect(snapshot.frames[0]).toMatchObject({
      file: created.file,
      title: "Pricing $& plans",
    });
    expect(snapshot.frames[0]).not.toHaveProperty("source");
    expect(snapshot.frames[0]).not.toHaveProperty("srcDoc");
    expect(snapshot.frames[0]).not.toHaveProperty("tree");
    const hydrated = await readDesignFrame(root, created.file);
    expect(hydrated.source).toContain("<!doctype html>");
    expect(hydrated.sourceVersion).toBe(snapshot.frames[0]?.sourceVersion);
    expect(hydrated.srcDoc).toContain("Content-Security-Policy");
    expect(hydrated.srcDoc).toContain("data-zeros-design-runtime");
    expect(hydrated.srcDoc).toContain("script-src 'sha256-");
    expect(hydrated.srcDoc).not.toContain("nonce=");
    expect(hydrated.srcDoc).toContain(
      `window.__zerosDesignSourceVersion="${snapshot.frames[0]!.sourceVersion}"`,
    );
    expect(hydrated.srcDoc).toContain('oid.replace(/["\\\\]/g, "\\\\$&")');
    expect(hydrated.srcDoc).not.toContain("\\</body>");
    expect(hydrated.srcDoc).not.toContain("allow-same-origin");
    expect(snapshot.tokens.some((token) => token.name === "--accent")).toBe(
      true,
    );
    expect(snapshot.lint.checkedFiles).toEqual([created.file]);
  });

  it("keeps healthy frames available when sibling frames exceed render budgets", async () => {
    await initializeDesignDocument(root);
    const healthy = await createDesignFrame(root, { title: "Healthy" });
    const oversized = await createDesignFrame(root, { title: "Oversized" });
    const stylesheetHeavy = await createDesignFrame(root, {
      title: "Stylesheet heavy",
    });
    const directory = path.join(root, DESIGN_DIRECTORY_NAME);
    await writeFile(
      path.join(directory, oversized.file),
      `<!doctype html><html><head><meta name="zeros-frame" content="title=Oversized"></head><body><main data-oid="oversized">${"x".repeat(2 * 1024 * 1024)}</main></body></html>`,
      "utf8",
    );
    await writeFile(
      path.join(directory, stylesheetHeavy.file),
      `<!doctype html><html><head><meta name="zeros-frame" content="title=Stylesheet heavy">${'<link rel="stylesheet" href="./tokens.css">'.repeat(129)}</head><body><main data-oid="stylesheet-heavy">Heavy</main></body></html>`,
      "utf8",
    );

    const snapshot = await readDesignWorkspaceSnapshot(root);

    expect(snapshot.frames.map((frame) => frame.file)).toEqual([healthy.file]);
    expect(
      snapshot.lint.violations.filter(
        (violation) => violation.ruleId === "render-budget",
      ),
    ).toEqual([
      expect.objectContaining({ file: oversized.file, severity: "error" }),
      expect.objectContaining({
        file: stylesheetHeavy.file,
        severity: "error",
      }),
    ]);
    expect(snapshot.tokens.length).toBeGreaterThan(0);
  });

  it("blocks forms, nested frames, and workers in inline frame documents", async () => {
    await initializeDesignDocument(root);
    await createDesignFrame(root, { title: "Restricted frame" });

    const summary = (await readDesignWorkspaceSnapshot(root)).frames[0]!;
    const srcDoc = (await readDesignFrame(root, summary.file)).srcDoc;

    expect(srcDoc).toContain("form-action 'none'");
    expect(srcDoc).toContain("frame-src 'none'");
    expect(srcDoc).toContain("worker-src 'none'");
  });

  it("maps stable oids to exact parse5 source ranges for future surgical writes", async () => {
    await initializeDesignDocument(root);
    await writeFile(
      path.join(root, DESIGN_DIRECTORY_NAME, "offsets.html"),
      `<!doctype html>
<html data-oid="page">
  <body data-oid="body">
    <main data-oid="hero"><h1 data-oid="heading">Hello</h1></main>
  </body>
</html>`,
      "utf8",
    );

    const offsets = await readDesignElementOffsetMap(root, "offsets.html");
    const hero = offsets.find((entry) => entry.oid === "hero");
    const heading = offsets.find((entry) => entry.oid === "heading");

    expect(hero).toMatchObject({
      tag: "main",
      startLine: 4,
      startColumn: 5,
    });
    expect(heading?.startOffset).toBeGreaterThan(hero?.startOffset ?? 0);
    expect(heading?.endOffset).toBeLessThan(hero?.endOffset ?? Infinity);
    expect(heading?.startTag).toEqual(
      expect.objectContaining({
        startOffset: expect.any(Number),
        endOffset: expect.any(Number),
      }),
    );
  });

  it("changes the rendered source version when linked CSS changes", async () => {
    await initializeDesignDocument(root);
    await createDesignFrame(root, { title: "Styled" });
    const before = (await readDesignWorkspaceSnapshot(root)).frames[0]!;
    expect(
      await readDesignFrameRenderIdentity(root, before.file),
    ).toMatchObject({
      file: before.file,
      sourceVersion: before.sourceVersion,
    });
    await writeFile(
      path.join(root, DESIGN_DIRECTORY_NAME, "tokens.css"),
      "\n:root { --accent: var(--fg2); }\n",
      { flag: "a" },
    );

    const after = (await readDesignWorkspaceSnapshot(root)).frames[0]!;
    expect(after.modifiedAt).toBe(before.modifiedAt);
    expect(after.sourceVersion).not.toBe(before.sourceVersion);
    expect(
      (await readDesignFrameRenderIdentity(root, after.file)).sourceVersion,
    ).toBe(after.sourceVersion);

    await updateDesignFrameGeometry(root, after.file, {
      x: after.x,
      y: after.y,
      w: after.width + 1,
      h: after.height,
      z: after.z,
    });
    const resized = (await readDesignWorkspaceSnapshot(root)).frames[0]!;
    expect(resized.sourceVersion).not.toBe(after.sourceVersion);
  });

  it("does not inline or parse stylesheet symlinks that escape the design directory", async () => {
    await initializeDesignDocument(root);
    const directory = path.join(root, DESIGN_DIRECTORY_NAME);
    const outsideStyles = path.join(root, "outside-secret.css");
    await writeFile(
      outsideStyles,
      ":root { --outside-secret: should-not-leak; }",
      "utf8",
    );
    await symlink(outsideStyles, path.join(directory, "linked-secret.css"));
    await writeFile(
      path.join(directory, "linked.html"),
      '<!doctype html><html><head><link rel="stylesheet" href="./linked-secret.css"></head><body data-oid="body"></body></html>',
      "utf8",
    );

    const snapshot = await readDesignWorkspaceSnapshot(root);
    expect(
      (await readDesignFrame(root, snapshot.frames[0]!.file)).srcDoc,
    ).not.toContain("--outside-secret");

    await rm(path.join(directory, "tokens.css"));
    await symlink(outsideStyles, path.join(directory, "tokens.css"));
    expect(await readDesignTokens(root)).toEqual([]);
  });

  it("refuses explicit frame operations on symlinks", async () => {
    await initializeDesignDocument(root);
    const directory = path.join(root, DESIGN_DIRECTORY_NAME);
    const outsideFrame = path.join(root, "outside-secret.html");
    const outsideSource =
      '<!doctype html><html><head><meta name="zeros-frame" content="title=Outside"></head><body>private</body></html>';
    await writeFile(outsideFrame, outsideSource, "utf8");
    await symlink(outsideFrame, path.join(directory, "outside.html"));

    await expect(
      lintDesignDocument(root, "outside.html", { healOids: false }),
    ).rejects.toThrow("Design frame not found");
    await expect(
      renameDesignFrame(root, "outside.html", "Leaked"),
    ).rejects.toThrow("Design frame not found");
    await expect(
      readDesignElementOffsetMap(root, "outside.html"),
    ).rejects.toThrow("Design frame not found");
    await expect(
      updateDesignFrameGeometry(root, "outside.html", { x: 20 }),
    ).rejects.toThrow("Design frame not found");
    expect(await readFile(outsideFrame, "utf8")).toBe(outsideSource);
  });

  it("keeps observational snapshots from healing source or persisting auto-placement", async () => {
    await initializeDesignDocument(root);
    const directory = path.join(root, DESIGN_DIRECTORY_NAME);
    const source =
      '<!doctype html><html><head><meta name="zeros-frame" content="width=800,height=600,title=Remote"></head><body><main>Remote</main></body></html>';
    await writeFile(path.join(directory, "remote.html"), source, "utf8");
    const canvasBefore = await readFile(
      path.join(directory, ".zeros-canvas.json"),
      "utf8",
    );

    const snapshot = await readDesignWorkspaceSnapshot(root, {
      writeBack: false,
    });

    expect(snapshot.frames[0]?.file).toBe("remote.html");
    expect(
      snapshot.lint.violations.some((item) => item.ruleId === "oid-missing"),
    ).toBe(true);
    expect(await readFile(path.join(directory, "remote.html"), "utf8")).toBe(
      source,
    );
    expect(
      await readFile(path.join(directory, ".zeros-canvas.json"), "utf8"),
    ).toBe(canvasBefore);
  });

  it("fails closed without replacing malformed canvas metadata", async () => {
    await initializeDesignDocument(root);
    const target = path.join(root, DESIGN_DIRECTORY_NAME, ".zeros-canvas.json");
    const malformed = '{"version":2,"frames":';
    await writeFile(target, malformed, "utf8");

    await expect(readDesignWorkspaceSnapshot(root)).rejects.toThrow(
      "invalid JSON",
    );
    expect(await readFile(target, "utf8")).toBe(malformed);
  });

  it("surgically updates inline styles and rejects stale or injected declarations", async () => {
    await initializeDesignDocument(root);
    const created = await createDesignFrame(root, { title: "Inspector" });
    const beforeSummary = (await readDesignWorkspaceSnapshot(root)).frames[0]!;
    const before = await readDesignFrame(root, beforeSummary.file);
    const sourceBefore = before.source;
    const main = before.tree[0];
    expect(main?.tag).toBe("main");

    const mutation = await updateDesignNodeStyles(root, {
      frame: created.file,
      nodeId: main!.oid!,
      sourceVersion: before.sourceVersion,
      styles: {
        padding: "32px",
        "background-color": "var(--bg2)",
      },
    });

    expect(mutation.changed).toBe(true);
    expect(mutation.frame.sourceVersion).not.toBe(before.sourceVersion);
    expect(mutation.frame.source).toBe(
      sourceBefore.replace(
        "padding:var(--space-8); gap:var(--space-4);",
        "padding:32px; gap:var(--space-4); background-color:var(--bg2);",
      ),
    );
    expect(
      mutation.lint.violations.filter((item) => item.severity === "error"),
    ).toEqual([]);

    const sourceAfter = mutation.frame.source;
    await expect(
      updateDesignNodeStyles(root, {
        frame: created.file,
        nodeId: main!.oid!,
        sourceVersion: before.sourceVersion,
        styles: { color: "red" },
      }),
    ).rejects.toThrow("changed before the mutation");
    await expect(
      updateDesignNodeStyles(root, {
        frame: created.file,
        nodeId: main!.oid!,
        sourceVersion: mutation.frame.sourceVersion,
        styles: { color: "red; position:fixed" },
      }),
    ).rejects.toThrow("Invalid CSS value");
    expect(
      await readFile(
        path.join(root, DESIGN_DIRECTORY_NAME, created.file),
        "utf8",
      ),
    ).toBe(sourceAfter);
  });

  it("allows a safe structured edit when an unrelated lint error already exists", async () => {
    await initializeDesignDocument(root);
    const created = await createDesignFrame(root, { title: "Legacy error" });
    const target = path.join(root, DESIGN_DIRECTORY_NAME, created.file);
    await writeFile(
      target,
      (await readFile(target, "utf8")).replace(
        "</body>",
        "<script>legacy()</script></body>",
      ),
    );
    const beforeSummary = (
      await readDesignWorkspaceSnapshot(root, {
        writeBack: false,
      })
    ).frames[0]!;
    const before = await readDesignFrame(root, beforeSummary.file, 4, {
      writeBack: false,
    });
    const main = before.tree[0]!;

    const mutation = await updateDesignNodeStyles(root, {
      frame: created.file,
      nodeId: main.oid!,
      sourceVersion: before.sourceVersion,
      styles: { padding: "24px" },
    });

    expect(mutation.changed).toBe(true);
    expect(mutation.frame.source).toContain("<script>legacy()</script>");
    expect(
      mutation.lint.violations.some(
        (violation) => violation.ruleId === "no-script",
      ),
    ).toBe(true);
  });

  it("does not treat oid healing as a newly introduced legacy error", async () => {
    await initializeDesignDocument(root);
    const created = await createDesignFrame(root, { title: "Legacy oid" });
    const target = path.join(root, DESIGN_DIRECTORY_NAME, created.file);
    await writeFile(
      target,
      (await readFile(target, "utf8")).replace(
        "</body>",
        '<a href="https://example.invalid">Legacy link</a></body>',
      ),
    );
    const beforeSummary = (
      await readDesignWorkspaceSnapshot(root, {
        writeBack: false,
      })
    ).frames[0]!;
    const before = await readDesignFrame(root, beforeSummary.file, 4, {
      writeBack: false,
    });
    const main = before.tree[0]!;

    const mutation = await updateDesignNodeStyles(root, {
      frame: created.file,
      nodeId: main.oid!,
      sourceVersion: before.sourceVersion,
      styles: { padding: "32px" },
    });

    expect(mutation.changed).toBe(true);
    expect(mutation.frame.source).toContain("https://example.invalid");
  });

  it("sanitizes parser-decoded active content before composing a frame", async () => {
    await initializeDesignDocument(root);
    await writeFile(
      path.join(root, DESIGN_DIRECTORY_NAME, "encoded.html"),
      `<!doctype html><html><head><meta http-equiv="refresh" content="0;url=https://evil.invalid"><meta http-equiv="Content-Security-Policy" content="script-src *"></head><body>
<a data-oid="link" href="java&#x73;cript:alert(1)" oNcLiCk=alert(2)>Open</a>
<svg><a data-oid="svg-link" xlink:href="j&#x61;vascript:alert(4)">SVG</a></svg>
<iframe data-oid="frame" srcdoc="&lt;script&gt;alert(3)&lt;/script&gt;"></iframe>
<script>window.pwned = true</script></body></html>`,
      "utf8",
    );

    const rendered = (
      await readDesignFrame(root, "encoded.html", 4, { writeBack: false })
    ).srcDoc;

    expect(rendered).not.toMatch(/javascript\s*:/i);
    expect(rendered).not.toMatch(/\sonclick\s*=/i);
    expect(rendered).not.toMatch(/\sxlink:href\s*=/i);
    expect(rendered).not.toMatch(/\ssrcdoc\s*=/i);
    expect(rendered).not.toMatch(/<iframe\b/i);
    expect(rendered).not.toContain("window.pwned");
    expect(rendered).not.toMatch(/http-equiv=["']?refresh/i);
    expect(rendered.match(/Content-Security-Policy/g)).toHaveLength(1);
  });

  it("inlines stylesheets independent of attribute order and escapes raw-text closure", async () => {
    await initializeDesignDocument(root);
    const fixtureColor = "rgb(1, 2, 3)"; // check:ui ignore-line (authored CSS fixture)
    await writeFile(
      path.join(root, DESIGN_DIRECTORY_NAME, "ordered.css"),
      `.ordered { color: ${fixtureColor}; } /* </style><script>bad()</script> */`,
      "utf8",
    );
    await writeFile(
      path.join(root, DESIGN_DIRECTORY_NAME, "ordered.html"),
      '<!doctype html><html><head><link href="./ordered.css" media="all" rel="preload stylesheet"></head><body><main class="ordered" data-oid="root">Styled</main></body></html>',
      "utf8",
    );

    const rendered = (
      await readDesignFrame(root, "ordered.html", 4, { writeBack: false })
    ).srcDoc;
    expect(rendered).toContain(`color: ${fixtureColor}`);
    expect(rendered).toContain("<\\/style><script>bad()");
    expect(rendered).not.toContain("</style><script>bad()");
  });

  it("removes every non-raster data URL while retaining bounded image payloads", async () => {
    await initializeDesignDocument(root);
    await writeFile(
      path.join(root, DESIGN_DIRECTORY_NAME, "data-urls.html"),
      `<!doctype html><html><body><main data-oid="main">
<iframe data-oid="plain" src="data:text/plain,active"></iframe>
<img data-oid="svg" src="data:image/svg+xml,%3Csvg%20onload=alert(1)%3E">
<img data-oid="png" src="data:image/png;base64,iVBORw==">
</main></body></html>`,
      "utf8",
    );

    const rendered = (
      await readDesignFrame(root, "data-urls.html", 4, { writeBack: false })
    ).srcDoc;

    expect(rendered).not.toContain("data:text/plain");
    expect(rendered).not.toMatch(/\bsrc=["']data:image\/svg\+xml/i);
    expect(rendered).toContain("data:image/png;base64,iVBORw==");
  });

  it("serializes oid-healing lint with document mutations", async () => {
    await initializeDesignDocument(root);
    await createDesignFrame(root, { title: "Locked lint" });
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const holding = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const first = withDesignDocumentWrite(root, async () => {
      entered();
      await blocker;
    });
    await holding;

    let settled = false;
    const lint = lintDesignDocument(root).finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    release();
    await first;
    await expect(lint).resolves.toMatchObject({ healedOids: 0 });
  });

  it("edits direct text and appends healed safe HTML without reserializing the frame", async () => {
    await initializeDesignDocument(root);
    const created = await createDesignFrame(root, { title: "Checkout" });
    const beforeSummary = (await readDesignWorkspaceSnapshot(root)).frames[0]!;
    const before = await readDesignFrame(root, beforeSummary.file);
    const main = before.tree[0];
    const heading = main?.children[0];

    const textMutation = await setDesignNodeText(root, {
      frame: created.file,
      nodeId: heading!.oid!,
      sourceVersion: before.sourceVersion,
      text: "Pay < securely & quickly",
    });
    expect(textMutation.frame.source).toContain(
      ">Pay &lt; securely &amp; quickly</h1>",
    );

    const htmlMutation = await writeDesignNodeHtml(root, {
      frame: created.file,
      nodeId: main!.oid!,
      sourceVersion: textMutation.frame.sourceVersion,
      mode: "append",
      html: "<button>Pay now</button>",
    });
    expect(htmlMutation.frame.source).toMatch(
      /<button data-oid="o-[^"]+">Pay now<\/button><\/main>/,
    );
    expect(htmlMutation.frame.nodeCount).toBe(before.nodeCount + 1);

    await expect(
      writeDesignNodeHtml(root, {
        frame: created.file,
        nodeId: main!.oid!,
        sourceVersion: htmlMutation.frame.sourceVersion,
        mode: "append",
        html: '<img src="https://example.com/tracker.png"><script>bad()</script>',
      }),
    ).rejects.toThrow("no-script");
    await expect(
      setDesignNodeText(root, {
        frame: created.file,
        nodeId: main!.oid!,
        sourceVersion: htmlMutation.frame.sourceVersion,
        text: "Would discard children",
      }),
    ).rejects.toThrow("contains element children");
  });

  it("duplicates and deletes frames while keeping canvas state exact", async () => {
    await initializeDesignDocument(root);
    const original = await createDesignFrame(root, { title: "Receipt" });
    const copy = await duplicateDesignFrame(root, original.file);

    expect(copy.file).toBe("receipt-copy.html");
    expect(copy.title).toBe("Receipt copy");
    expect((await listDesignFrames(root)).map((frame) => frame.file)).toEqual([
      original.file,
      copy.file,
    ]);

    await deleteDesignFrame(root, original.file);
    expect((await listDesignFrames(root)).map((frame) => frame.file)).toEqual([
      copy.file,
    ]);
    await expect(
      readDesignElementOffsetMap(root, original.file),
    ).rejects.toThrow("Design frame not found");
  });

  it("discovers safe local image assets, inlines them for rendering, and inserts them by oid", async () => {
    await initializeDesignDocument(root);
    const created = await createDesignFrame(root, { title: "Gallery" });
    const directory = path.join(root, DESIGN_DIRECTORY_NAME);
    const assetFile = path.join(directory, "assets", "mark.png");
    await writeFile(assetFile, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    expect(await listDesignAssets(root)).toEqual([
      expect.objectContaining({
        path: "assets/mark.png",
        name: "mark.png",
        mimeType: "image/png",
        dataUrl: "data:image/png;base64,iVBORw==",
      }),
    ]);

    const before = (await readDesignWorkspaceSnapshot(root)).frames[0]!;
    const mutation = await insertDesignAsset(root, {
      frame: created.file,
      sourceVersion: before.sourceVersion,
      assetPath: "assets/mark.png",
      x: 48,
      y: 72,
    });
    expect(mutation.frame.source).toContain('src="./assets/mark.png"');
    expect(mutation.frame.source).toContain("left:48px; top:72px;");
    expect(mutation.frame.srcDoc).toContain(
      'src="data:image/png;base64,iVBORw=="',
    );

    const versionBeforeAssetEdit = mutation.frame.sourceVersion;
    await writeFile(assetFile, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]));
    const afterAssetEdit = (await readDesignWorkspaceSnapshot(root)).frames[0]!;
    expect(afterAssetEdit.sourceVersion).not.toBe(versionBeforeAssetEdit);
  });

  it("bounds repeated asset expansion before it can exhaust renderer memory", async () => {
    await initializeDesignDocument(root);
    const directory = path.join(root, DESIGN_DIRECTORY_NAME);
    await writeFile(
      path.join(directory, "assets", "large.png"),
      Buffer.alloc(1024 * 1024, 1),
    );
    const images = Array.from(
      { length: 13 },
      (_, index) => `<img data-oid="image-${index}" src="./assets/large.png">`,
    ).join("");
    await writeFile(
      path.join(directory, "bounded.html"),
      `<!doctype html><html><head><meta name="zeros-frame" content="width=800,height=600,title=Bounded"></head><body><main data-oid="main">${images}</main></body></html>`,
      "utf8",
    );

    await expect(
      readDesignFrame(root, "bounded.html", 4, { writeBack: false }),
    ).rejects.toThrow(/per-frame (?:inline budget|render limit)/);
  });
});
