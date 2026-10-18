import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DESIGN_DIRECTORY_NAME,
  initializeDesignDocument,
  lintDesignDocument,
  readDesignFrameRenderIdentityFromSource,
  readDesignFrameRenderSourceFromSource,
  readDesignWorkspaceSnapshot,
  updateDesignFrameGeometry,
} from "../document";
import { prepareFrameRenderSource } from "../render-preparation";
import { readCanvas } from "../document-storage";

describe("imported style sources in rendered frames", () => {
  let root: string;
  let folder: string;
  const frame = "page-1/home.html";
  const html =
    '<!doctype html><html><head><style>.own { color: red; }</style></head><body><main data-oid="main">Hi</main></body></html>';

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "zeros-style-source-render-"));
    folder = path.join(root, DESIGN_DIRECTORY_NAME);
    await initializeDesignDocument(root);
    await mkdir(path.join(root, "styles"), { recursive: true });
    await writeFile(
      path.join(root, "styles/app.css"),
      ':root { --brand: 1px; } [data-theme="light"] { --brand: 2px; }',
    );
    await writeFile(path.join(folder, frame), html);
    await writeCanvas((canvas) => {
      canvas.styles = [
        { id: "app", title: "App", kind: "css", path: "styles/app.css", themes: { light: '[data-theme="light"]' } },
      ];
      canvas.frames.home = { kind: "html", source: frame, title: "Home", x: 0, y: 0, width: 390, height: 844 };
      canvas.pages[0].frames.push("home");
    });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeCanvas(edit: (canvas: Record<string, any>) => void) {
    const file = path.join(folder, "meta/canvas.json");
    const canvas = JSON.parse(await readFile(file, "utf8"));
    edit(canvas);
    await writeFile(file, JSON.stringify(canvas, null, 2));
  }
  const render = () => readDesignFrameRenderSourceFromSource(root, frame, html);

  it("renders the source before the frame's own CSS, with its theme mapped", async () => {
    const rendered = (await render()).html;
    const imported = rendered.indexOf('<style data-zeros-style-source="app"');
    expect(imported).toBeGreaterThan(-1);
    expect(imported).toBeLessThan(rendered.indexOf(".own { color: red; }"));
    expect(rendered).toContain('[data-zd-theme="light"] { --brand: 2px; }');
  });

  it("lets a frame opt out and reports every source's status in the snapshot", async () => {
    const snapshot = await readDesignWorkspaceSnapshot(root);
    expect(snapshot.styleSources).toEqual([
      expect.objectContaining({
        id: "app",
        status: "ready",
        themes: ["light"],
        tokens: [{ name: "--brand", value: "1px", themeValues: { light: "2px" } }],
      }),
    ]);
    expect(snapshot.styleSources[0]).not.toHaveProperty("css");
    await writeCanvas((canvas) => {
      canvas.frames.home.styles = [];
    });
    expect((await render()).html).not.toContain("data-zeros-style-source");
  });

  it("gives frames a new version when the source file changes, so the canvas refreshes", async () => {
    const before = (await readDesignWorkspaceSnapshot(root)).frames[0]!.sourceVersion;
    await writeFile(path.join(root, "styles/app.css"), ":root { --brand: 9px; }");
    const later = new Date(Date.now() + 5_000);
    await utimes(path.join(root, "styles/app.css"), later, later);
    const after = (await readDesignWorkspaceSnapshot(root)).frames[0]!.sourceVersion;
    expect(after).not.toBe(before);
    expect((await render()).html).toContain("9px");
  });

  it("reports an oversized frame from its identity as well as its document", async () => {
    // Eight declarations of one near-limit file add up to more than 15 MiB.
    await writeFile(path.join(root, "styles/big.css"), `:root { --pad: "${"x".repeat(1_990_000)}"; }`);
    await writeCanvas((canvas) => {
      canvas.styles = Array.from({ length: 8 }, (_, index) => ({ id: `big${index}`, kind: "css", path: "styles/big.css" }));
    });
    await expect(render()).rejects.toThrow(/15 MiB/);
    await expect(readDesignFrameRenderIdentityFromSource(root, frame, html)).rejects.toThrow(/15 MiB/);
  });

  it("embeds the fonts a source's @font-face rules use in the frames that use it", async () => {
    const font = Buffer.from("wOF2 fixture font");
    await mkdir(path.join(root, "styles/files"), { recursive: true });
    await writeFile(path.join(root, "styles/files/brand.woff2"), font);
    await writeFile(
      path.join(root, "styles/app.css"),
      "@font-face { font-family: Brand; src: url(./files/brand.woff2) format('woff2'); } :root { --brand: 1px; } .unused { font-family: Brand; }",
    );
    // No rule the frame matches names the family yet, so it is not carried.
    expect((await render()).html).not.toContain("@font-face");
    await writeFile(
      path.join(root, "styles/app.css"),
      "@font-face { font-family: Brand; src: url(./files/brand.woff2) format('woff2'); } :root { --brand: 1px; } main { font-family: Brand; }",
    );
    const later = new Date(Date.now() + 5_000);
    await utimes(path.join(root, "styles/app.css"), later, later);
    const rendered = (await render()).html;
    expect(rendered).toContain(`url("data:font/woff2;base64,${font.toString("base64")}") format('woff2')`);
  });

  it.each(["css", "build", "tailwind"])("embeds %s source images and refreshes when they change or appear", async (kind) => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
    const asset = path.join(root, "styles/dot.png");
    await writeFile(path.join(root, "styles/app.css"), `${kind === "tailwind" ? '@import "tailwindcss";' : ""} main { background-image: url(./dot.png); }`);
    await writeCanvas((canvas) => { canvas.styles = [{ id: "app", kind, path: "styles/app.css" }]; });
    const missing = await render();
    await writeFile(asset, png);
    const first = await render();
    expect(first.html).toContain(`data:image/png;base64,${png.toString("base64")}`);
    expect(first.sourceVersion).not.toBe(missing.sourceVersion);
    const edited = Buffer.concat([png, Buffer.from([1])]);
    await writeFile(asset, edited);
    const later = new Date(Date.now() + 5_000);
    await utimes(asset, later, later);
    const updated = await render();
    expect(updated.html).toContain(`data:image/png;base64,${edited.toString("base64")}`);
    expect(updated.sourceVersion).not.toBe(first.sourceVersion);
    const identity = await readDesignFrameRenderIdentityFromSource(root, frame, html);
    expect(identity.sourceVersion).toBe(updated.sourceVersion);
  });

  it("keeps Tailwind theme variables used only by linked CSS and refreshes its candidates", async () => {
    await writeFile(path.join(root, "styles/app.css"), '@import "tailwindcss"; @theme { --color-brand: rebeccapurple; --color-other: seagreen; }');
    await writeCanvas((canvas) => { canvas.styles = [{ id: "app", kind: "tailwind", path: "styles/app.css" }]; });
    const linked = '<!doctype html><html><head><link rel="stylesheet" href="../tokens.css"></head><body><main class="hero">Hi</main></body></html>';
    await writeFile(path.join(folder, "tokens.css"), ".hero { color: var(--color-brand); }");
    const first = await readDesignFrameRenderSourceFromSource(root, frame, linked);
    expect(first.html).toContain("--color-brand: rebeccapurple");
    expect(first.html).not.toContain("--color-other: seagreen");
    const identity = await readDesignFrameRenderIdentityFromSource(root, frame, linked);
    expect(identity.sourceVersion).toBe(first.sourceVersion);
    await writeFile(path.join(folder, "tokens.css"), ".hero { color: var(--color-other); }");
    const later = new Date(Date.now() + 5_000);
    await utimes(path.join(folder, "tokens.css"), later, later);
    const second = await readDesignFrameRenderSourceFromSource(root, frame, linked);
    expect(second.html).toContain("--color-other: seagreen");
    expect(second.html).not.toContain("--color-brand: rebeccapurple");
    expect(second.sourceVersion).not.toBe(first.sourceVersion);
    const canvas = await readCanvas(root);
    const snapshot = await prepareFrameRenderSource(root, linked, { width: 390, height: 844 },
      { "tokens.css": ".hero { color: var(--color-brand); }" }, undefined, frame, canvas);
    expect(snapshot.sanitized).toContain("--color-brand: rebeccapurple");
    expect(snapshot.sanitized).not.toContain("--color-other: seagreen");
  });

  it("compiles a Tailwind source for the classes the frame and its components use", async () => {
    await writeFile(path.join(root, "styles/app.css"), '@import "tailwindcss" source(none); @theme inline { --color-brand: var(--brand); } :root { --brand: 1px; }');
    await mkdir(path.join(folder, "components"), { recursive: true });
    await writeFile(path.join(folder, "components/badge.html"), '<!doctype html><html><body><span data-zid="badge" class="rounded-md px-2">Badge</span></body></html>');
    const source = '<!doctype html><html><head></head><body><main data-oid="main" class="bg-brand p-3"><zd-badge data-oid="badge"></zd-badge></main></body></html>';
    await writeFile(path.join(folder, frame), source);
    await writeCanvas((canvas) => {
      canvas.styles = [{ id: "app", title: "App", kind: "tailwind", path: "styles/app.css" }];
    });
    const rendered = await readDesignFrameRenderSourceFromSource(root, frame, source);
    for (const rule of [".bg-brand", ".p-3", ".rounded-md", ".px-2"]) expect(rendered!.html).toContain(rule);
    expect(rendered!.html).not.toContain(".m-4");
    const identity = await readDesignFrameRenderIdentityFromSource(root, frame, source);
    expect(identity.sourceVersion).toBe(rendered!.sourceVersion);
    const restyled = source.replace("p-3", "p-4");
    expect((await readDesignFrameRenderIdentityFromSource(root, frame, restyled)).sourceVersion).not.toBe(identity.sourceVersion);
  });

  it("counts tokens the frame's imported Tailwind and CSS sources declare as known", async () => {
    await writeFile(
      path.join(root, "styles/app.css"),
      '@import "tailwindcss" source(none); @theme inline { --color-brand: var(--brand); --radius-card: 6px; --text-tiny--line-height: 1.2; } :root { --fg1: black; --brand: red; } [data-theme="light"] { --fg1: white; }',
    );
    await writeFile(
      path.join(root, "styles/semantic.css"),
      ':root { --switch-on-bg: var(--fg1); } [data-theme="light"] { --switch-thumb: white; }',
    );
    const uses = [
      "--fg1",
      "--radius-card",
      "--text-tiny--line-height",
      "--switch-on-bg",
      "--switch-thumb",
      // Tailwind's stock theme: the application never declares it.
      "--shadow-xl",
      "--made-up",
    ];
    const source = `<!doctype html><html><head><style>main { ${uses
      .map((name, index) => `--use-${index}: var(${name});`)
      .join(" ")} }</style></head><body><main data-oid="main">Hi</main></body></html>`;
    await writeFile(path.join(folder, frame), source);
    await writeFile(path.join(folder, "page-1/opted-out.html"), source);
    await writeCanvas((canvas) => {
      canvas.styles = [
        { id: "app", title: "App", kind: "tailwind", path: "styles/app.css", themes: { light: '[data-theme="light"]' } },
        { id: "semantic", title: "Semantic", kind: "css", path: "styles/semantic.css", themes: { light: '[data-theme="light"]' } },
      ];
      canvas.frames.opted = {
        kind: "html",
        source: "page-1/opted-out.html",
        title: "Opted out",
        x: 500,
        y: 0,
        width: 390,
        height: 844,
        styles: ["semantic"],
      };
      canvas.pages[0].frames.push("opted");
    });
    const unknown = (report: Awaited<ReturnType<typeof lintDesignDocument>>, file: string) =>
      report.violations
        .filter((violation) => violation.ruleId === "unknown-token" && violation.file === file)
        .map((violation) => /"(--[^"]+)"/.exec(violation.message)?.[1]);
    const report = await lintDesignDocument(root, undefined, { healOids: false });
    expect(unknown(report, frame)).toEqual(["--shadow-xl", "--made-up"]);
    // A frame that receives only the CSS source does not see Tailwind's tokens.
    expect(unknown(report, "page-1/opted-out.html")).toEqual([
      "--fg1",
      "--radius-card",
      "--text-tiny--line-height",
      "--shadow-xl",
      "--made-up",
    ]);
    const single = await lintDesignDocument(root, frame, { healOids: false });
    expect(unknown(single, frame)).toEqual(["--shadow-xl", "--made-up"]);
  });

  it("keeps the declaration through canvas writes, as older engines do", async () => {
    await updateDesignFrameGeometry(root, frame, { x: 40 });
    const canvas = JSON.parse(await readFile(path.join(folder, "meta/canvas.json"), "utf8"));
    expect(canvas.styles).toEqual([
      { id: "app", title: "App", kind: "css", path: "styles/app.css", themes: { light: '[data-theme="light"]' } },
    ]);
    expect(canvas.frames.home.x).toBe(40);
  });
});
