import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CanvasDocument } from "../document-model";
import { configureDesignStyleBuilds, type DesignWorkspaceSetupState } from "../style-builds";
import { configureDesignFonts, resetDesignFontsForTests, settleDesignFontDownloadsForTests } from "../style-fonts";
import {
  MAX_DESIGN_STYLE_SOURCE_FONT_BYTES,
  designStyleSourcePathError,
  forgetDesignStyleSourceCaches,
  frameStyleSourceIds,
  frameStyleSources,
  importPlainDesignCss,
  readDesignStyleSourceCatalog,
  readDesignStyleSources,
  resolveDesignStyleSource,
  type DesignStyleSourceDeclaration,
} from "../style-sources";

const roots: string[] = [];
function workspace(files: Record<string, string> = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), "zeros-style-sources-"));
  roots.push(root);
  for (const [file, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), body);
  }
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function canvas(styles: unknown, frameInfo: CanvasDocument["frame_info"] = {}): CanvasDocument {
  return {
    version: 3,
    frames: {},
    frame_info: frameInfo,
    foundation: { schemaVersion: 1, parameters: [], variants: [], components: [] },
    ...(styles === undefined ? {} : { styles }),
  } as unknown as CanvasDocument;
}

const declaration = (overrides: Partial<DesignStyleSourceDeclaration> = {}): DesignStyleSourceDeclaration => ({
  id: "app",
  title: "App",
  kind: "css",
  path: "styles/app.css",
  themes: {},
  ...overrides,
});

describe("style source declarations", () => {
  it("keeps valid entries and reports malformed ones without failing the canvas", () => {
    const catalog = readDesignStyleSourceCatalog(canvas([
      { id: "app", kind: "css", path: "styles/app.css", themes: { light: '[data-theme="light"]', "Bad Name": ".x" } },
      { id: "1bad", kind: "css", path: "a.css" },
      { id: "app", kind: "css", path: "dup.css" },
      "not an object",
    ]));
    expect(catalog.declarations).toEqual([
      { id: "app", title: "app", kind: "css", path: "styles/app.css", themes: { light: '[data-theme="light"]' } },
    ]);
    expect(catalog.errors).toHaveLength(3);
    expect(readDesignStyleSourceCatalog(canvas(undefined))).toEqual({ declarations: [], errors: [] });
    expect(readDesignStyleSourceCatalog(canvas({})).errors).toEqual(["meta/canvas.json `styles` must be a list."]);
  });

  it("accepts only repository-relative .css paths outside .git and .zeros", () => {
    expect(designStyleSourcePathError("styles/app.css")).toBeNull();
    expect(designStyleSourcePathError("node_modules/kit/theme.css")).toBeNull();
    for (const bad of ["/etc/app.css", "../app.css", "styles/../../app.css", "styles\\app.css", ".git/x.css", ".zeros/x.css", "styles/app.scss", ""]) {
      expect(designStyleSourcePathError(bad), bad).not.toBeNull();
    }
  });

  it("applies every source by default and a frame's own list when it has one", () => {
    const catalog = readDesignStyleSourceCatalog(canvas([
      { id: "app", kind: "css", path: "a.css" },
      { id: "brand", kind: "css", path: "b.css" },
    ]));
    const info = (styles?: unknown) => ({ "page/a.html": { id: "a", title: "A", kind: "frame", ...(styles === undefined ? {} : { styles }) } }) as CanvasDocument["frame_info"];
    expect(frameStyleSourceIds({ frame_info: info() }, catalog, "page/a.html")).toEqual(["app", "brand"]);
    expect(frameStyleSourceIds({ frame_info: info(["brand", "missing", "brand", "app"]) }, catalog, "page/a.html")).toEqual(["brand", "app"]);
    expect(frameStyleSourceIds({ frame_info: info([]) }, catalog, "page/a.html")).toEqual([]);
  });
});

describe("plain CSS import", () => {
  it("skips what a browser cannot use and lifts Tailwind @theme tokens into :root", () => {
    const imported = importPlainDesignCss(`
      @import "tailwindcss" source(none);
      @source "../src";
      @custom-variant dark (&:where([data-theme=dark] *));
      @font-face { font-family: Brand; src: url(brand.woff2); }
      @theme inline { --color-*: initial; --radius-md: 6px; --font-sans: Inter, sans-serif; }
      :root { --bg1: 7px; }
      .card { @apply p-3; color: var(--fg1); }
    `, {});
    expect(imported.css).not.toMatch(/@import|@source|@custom-variant|@theme|@apply/);
    // Fonts are embedded when the source is resolved against the repository.
    expect(imported.css).toContain("@font-face { font-family: Brand; src: url(brand.woff2); }");
    expect(imported.css).toContain("--radius-md: 6px");
    expect(imported.tokens.map((token) => token.name).sort()).toEqual(["--bg1", "--font-sans", "--radius-md"]);
    expect(imported.messages.map((message) => message.level)).toEqual(["info", "info"]);
  });

  it("drops comments and shows multi-line values on one line", () => {
    const imported = importPlainDesignCss("/* scale */ :root { --gap: calc(\n    1px + 2px\n  ); }", {});
    expect(imported.css).not.toContain("scale");
    expect(imported.tokens).toEqual([{ name: "--gap", value: "calc(1px + 2px)", themeValues: {} }]);
  });

  it("maps a source's theme selectors onto Design themes without touching longer names", () => {
    const imported = importPlainDesignCss(`
      :root { --bg1: black; }
      [data-theme="light"] { --bg1: white; }
      .dark .x { color: red; }
      .darker { color: blue; }
    `, { light: '[data-theme="light"]', dark: ".dark" });
    expect(imported.css).toContain('[data-zd-theme="light"] { --bg1: white; }');
    expect(imported.css).toContain('[data-zd-theme="dark"] .x');
    expect(imported.css).toContain(".darker");
    expect(imported.tokens).toEqual([{ name: "--bg1", value: "black", themeValues: { light: "white" } }]);
    expect(importPlainDesignCss(":root { --a: 1; }", { light: ".light" }).messages)
      .toEqual([{ level: "warning", text: 'Theme "light": no rule uses the selector .light.', action: "agent" }]);
  });
});

describe("themes from prefers-color-scheme", () => {
  it("maps the media query onto a Design theme, keeping specificity, order and tokens", () => {
    const { css, tokens, messages } = importPlainDesignCss(
      ":root { --bg: white; } body { color: black; } " +
        "@media (prefers-color-scheme: dark) { :root { --bg: black; } .card { color: white; } } " +
        "@media screen and (prefers-color-scheme: dark) { html { color-scheme: dark; } } " +
        ".x { @media (prefers-color-scheme: dark) { color: red; } } " +
        "@media (prefers-color-scheme: light) { .y { color: blue; } }",
      { dark: "@media (prefers-color-scheme: dark)" },
    );
    expect(messages).toEqual([]);
    expect(css).toContain(':root:where([data-zd-theme="dark"]) { --bg: black; }');
    expect(css).toContain(':where([data-zd-theme="dark"]) .card { color: white; }');
    expect(css).toContain('@media screen { html:where([data-zd-theme="dark"]) { color-scheme: dark; } }');
    expect(css).toContain('.x { &:where([data-zd-theme="dark"], [data-zd-theme="dark"] *) { color: red; } }');
    expect(css).not.toContain("prefers-color-scheme: dark");
    // A scheme no theme maps stays a media query.
    expect(css).toContain("@media (prefers-color-scheme: light) { .y { color: blue; } }");
    expect(tokens).toEqual([{ name: "--bg", value: "white", themeValues: { dark: "black" } }]);
  });

  it("reports a media mapping the stylesheet never uses, and rejects other media queries", () => {
    expect(importPlainDesignCss(":root { --bg: white; }", { dark: "@media (prefers-color-scheme: dark)" }).messages).toEqual([
      { level: "warning", text: 'Theme "dark": the stylesheet has no @media (prefers-color-scheme: dark) rule.', action: "agent" },
    ]);
    const catalog = readDesignStyleSourceCatalog(canvas([
      { id: "app", kind: "css", path: "a.css", themes: { dark: "@media (prefers-color-scheme: dark)", wide: "@media (min-width: 900px)" } },
    ]));
    expect(catalog.declarations[0]!.themes).toEqual({ dark: "@media (prefers-color-scheme: dark)" });
    expect(catalog.errors).toEqual([
      'Style source "app" theme "wide": only @media (prefers-color-scheme: dark) or @media (prefers-color-scheme: light) can map a theme; use a selector otherwise.',
    ]);
  });

  it("follows a Tailwind entry's default dark variant into the mapped theme", async () => {
    const root = workspace({ "styles/app.css": '@import "tailwindcss"; :root { --bg: white; } @media (prefers-color-scheme: dark) { :root { --bg: black; } }' });
    const document = canvas([{ id: "app", kind: "tailwind", path: "styles/app.css", themes: { dark: "@media (prefers-color-scheme: dark)" } }]);
    const [frame] = await frameStyleSources(root, document, "page/home.html", { html: '<main class="dark:p-2"></main>' });
    expect(frame!.css).toContain('&:where([data-zd-theme="dark"], [data-zd-theme="dark"] *)');
    expect(frame!.css).not.toContain("prefers-color-scheme: dark");
    const [status] = (await readDesignStyleSources(root, document)).sources;
    expect(status!.status).toBe("ready");
    expect(status!.tokens).toEqual([{ name: "--bg", value: "white", themeValues: { dark: "black" } }]);
  });
});

describe("resolving a source in the workspace", () => {
  it("reads a repository file, reports status and caches until the file changes", async () => {
    const root = workspace({ "styles/app.css": ":root { --bg1: black; }" });
    const first = await resolveDesignStyleSource(root, declaration());
    expect(first).toMatchObject({ status: "ready", messages: [], css: expect.stringContaining("--bg1: black") });
    expect(await resolveDesignStyleSource(root, declaration())).toBe(first);
    writeFileSync(path.join(root, "styles/app.css"), ":root { --bg1: white; }");
    utimesSync(path.join(root, "styles/app.css"), new Date(), new Date(Date.now() + 5_000));
    const changed = await resolveDesignStyleSource(root, declaration());
    expect(changed.css).toContain("--bg1: white");
    expect(changed.revision).not.toBe(first.revision);
  });

  it("re-reads every source on Update, even when a file kept its size and time", async () => {
    const root = workspace({ "styles/app.css": ":root { --bg1: black; }" });
    const file = path.join(root, "styles/app.css");
    const when = new Date("2026-01-01T00:00:00Z");
    utimesSync(file, when, when);
    const first = await resolveDesignStyleSource(root, declaration());
    writeFileSync(file, ":root { --bg1: white; }");
    utimesSync(file, when, when);
    expect((await resolveDesignStyleSource(root, declaration())).css).toBe(first.css);
    forgetDesignStyleSourceCaches(root);
    expect((await resolveDesignStyleSource(root, declaration())).css).toContain("--bg1: white");
  });

  it("says what resolves each problem: Update for installs, the agent for declarations", async () => {
    const root = workspace({ "styles/app.css": '@import "tailwindcss"; @import "tw-animate-css"; @import "./gone.css";' });
    const status = await resolveDesignStyleSource(root, declaration({ kind: "tailwind" }));
    expect(status.messages.filter((message) => message.action).map((message) => message.action)).toEqual(["agent", "update"]);
    expect((await resolveDesignStyleSource(root, declaration({ path: "styles/missing.css" }))).messages[0]!.action).toBe("agent");
  });

  it("fails closed for unsupported kinds, missing files, symlinks and invalid CSS", async () => {
    const root = workspace({ "outside.css": ":root{}", "styles/broken.css": ".a { color: red" });
    symlinkSync(path.join(root, "outside.css"), path.join(root, "styles/link.css"));
    for (const [overrides, text] of [
      [{ kind: "less" }, /not available/],
      [{ path: "styles/missing.css" }, /^styles\/missing\.css does not exist\.$/],
      [{ path: "styles/link.css" }, /is a symbolic link; declare the file it points to instead/],
      [{ path: "node_modules/@fontsource-variable/geist/index.css" }, /is not installed in this workspace\. Run the workspace setup/],
      [{ path: "styles/broken.css" }, /not valid CSS/],
    ] as const) {
      const resolved = await resolveDesignStyleSource(root, declaration(overrides));
      expect(resolved).toMatchObject({ status: "error", css: null, revision: null });
      expect(resolved.messages[0]!.text).toMatch(text);
    }
  });

  it("lists a frame's importable sources in order and skips failed ones", async () => {
    const root = workspace({
      "styles/app.css": ":root { --bg1: black; }",
      "styles/brand.css": ":root { --brand: blue; }",
    });
    const document = canvas([
      { id: "app", kind: "css", path: "styles/app.css" },
      { id: "brand", kind: "css", path: "styles/brand.css" },
      { id: "gone", kind: "css", path: "styles/gone.css" },
    ]);
    const sources = await frameStyleSources(root, document, "page/a.html");
    expect(sources.map((source) => source.id)).toEqual(["app", "brand"]);
    expect(sources[0]!.revision).toMatch(/^[a-f0-9]{24}$/);
    const status = await readDesignStyleSources(root, document);
    expect(status.errors).toEqual([]);
    expect(status.sources.map((source) => source.status)).toEqual(["ready", "ready", "error"]);
  });
});

describe("fonts in imported sources", () => {
  const font = Buffer.from("wOF2 fixture font");
  const embedded = (bytes: Buffer, type = "woff2") => `url("data:font/${type};base64,${bytes.toString("base64")}")`;

  it("embeds each local font a source's @font-face rules use, through a pnpm package link", async () => {
    const store = "node_modules/.pnpm/@fontsource-variable+geist@5.2.8/node_modules/@fontsource-variable/geist";
    const root = workspace({
      [`${store}/index.css`]:
        "@font-face { font-family: 'Geist Variable'; font-weight: 100 900; src: url(./files/geist-latin.woff2?v=1) format('woff2-variations'); unicode-range: U+0000-00FF; }\n" +
        "@media (min-width: 1px) { @font-face { font-family: Mono; src: local(Menlo), url(files/mono.ttf); } }",
    });
    mkdirSync(path.join(root, store, "files"));
    writeFileSync(path.join(root, store, "files/geist-latin.woff2"), font);
    writeFileSync(path.join(root, store, "files/mono.ttf"), font);
    mkdirSync(path.join(root, "node_modules/@fontsource-variable"), { recursive: true });
    symlinkSync(path.join(root, store), path.join(root, "node_modules/@fontsource-variable/geist"), "dir");
    const resolved = await resolveDesignStyleSource(root, declaration({ path: "node_modules/@fontsource-variable/geist/index.css" }));
    expect(resolved.status).toBe("ready");
    expect(resolved.css).toContain(`src: ${embedded(font)} format('woff2-variations'); unicode-range: U+0000-00FF;`);
    expect(resolved.css).toContain(`src: local(Menlo), ${embedded(font, "ttf")}`);
    expect(resolved.messages).toEqual([
      { level: "info", text: "Embeds 2 font files (1 KB); each frame receives only the faces it uses." },
    ]);
  });

  it("reports font references it cannot embed and keeps the rest of the rule", async () => {
    const root = workspace({
      "outside.woff2": "x",
      "styles/app.css":
        "@font-face { font-family: A; src: url(https://fonts.example/a.woff2), url(missing.woff2), url(../../outside.woff2), url(logo.svg), url(data:font/woff2;base64,AAAA); }",
    });
    const resolved = await resolveDesignStyleSource(root, declaration());
    expect(resolved.status).toBe("warning");
    expect(resolved.css).toContain("url(https://fonts.example/a.woff2), url(missing.woff2), url(../../outside.woff2), url(logo.svg), url(data:font/woff2;base64,AAAA)");
    expect(resolved.messages).toEqual([
      {
        level: "warning",
        text: "Could not embed 4 font references: https://fonts.example/a.woff2, missing.woff2, ../../outside.woff2 and 1 more. Only .woff2, .woff, .ttf and .otf files inside the repository can be embedded, up to 16 MiB per source. Frames use the next font in each font-family list instead.",
      },
    ]);
  });

  it("gives the source a new revision when a font it embeds changes", async () => {
    const root = workspace({ "styles/app.css": "@font-face { font-family: A; src: url(a.woff2); }" });
    writeFileSync(path.join(root, "styles/a.woff2"), font);
    const first = await resolveDesignStyleSource(root, declaration());
    expect(await resolveDesignStyleSource(root, declaration())).toBe(first);
    const edited = Buffer.concat([font, Buffer.from([1])]);
    writeFileSync(path.join(root, "styles/a.woff2"), edited);
    utimesSync(path.join(root, "styles/a.woff2"), new Date(), new Date(Date.now() + 5_000));
    const changed = await resolveDesignStyleSource(root, declaration());
    expect(changed.revision).not.toBe(first.revision);
    expect(changed.css).toContain(embedded(edited));
  });

  it("stops embedding fonts at the per-source budget", async () => {
    const root = workspace({
      "styles/app.css": "@font-face { font-family: A; src: url(a.woff2); } @font-face { font-family: B; src: url(b.woff2); }",
    });
    writeFileSync(path.join(root, "styles/a.woff2"), Buffer.alloc(MAX_DESIGN_STYLE_SOURCE_FONT_BYTES - 1));
    writeFileSync(path.join(root, "styles/b.woff2"), font);
    const resolved = await resolveDesignStyleSource(root, declaration());
    expect(resolved.status).toBe("warning");
    expect(resolved.css).toContain("src: url(b.woff2)");
    expect(resolved.messages.map((message) => message.text)).toEqual([
      "Embeds 1 font file (16384 KB); each frame receives only the faces it uses.",
      expect.stringMatching(/^Could not embed 1 font reference: b\.woff2\. .*16 MiB/),
    ]);
  });
});

describe("images in imported sources", () => {
  it("resolves each Tailwind import's images against its own directory", async () => {
    const root = workspace({
      "styles/app.css": '@import "tailwindcss"; @import "./brand/card.css";',
      "styles/brand/card.css": ".hero { background: url(./dot.png?v=1); }",
      "styles/brand/dot.png": "brand-image",
      "styles/dot.png": "wrong-image",
    });
    const document = canvas([declaration({ kind: "tailwind" })]);
    const [rendered] = await frameStyleSources(root, document, "page/home.html");
    expect(rendered!.css).toContain(`data:image/png;base64,${Buffer.from("brand-image").toString("base64")}`);
    expect(rendered!.css).not.toContain(Buffer.from("wrong-image").toString("base64"));
  });

  it("refuses outside, private and symlinked assets while embedding a valid image", async () => {
    const outside = workspace({ "outside.png": "outside-image" });
    const root = workspace({
      ".git/private.png": "git-private",
      ".zeros/private.png": "zeros-private",
      "styles/dot.png": "valid-image",
      "styles/app.css": ".hero { background: url(./dot.png), url(./link.png), url(./external/outside.png), url(../.git/private.png), url(../.zeros/private.png), url(../../outside.png), url(https://example.com/image.png); }",
    });
    symlinkSync(path.join(outside, "outside.png"), path.join(root, "styles/link.png"));
    symlinkSync(outside, path.join(root, "styles/external"), "dir");
    const resolved = await resolveDesignStyleSource(root, declaration());
    expect(resolved.status).toBe("warning");
    expect(resolved.css!.match(/data:image\/png/g)).toHaveLength(1);
    expect(resolved.css).toContain(Buffer.from("valid-image").toString("base64"));
    for (const secret of ["outside-image", "git-private", "zeros-private"]) {
      expect(resolved.css).not.toContain(Buffer.from(secret).toString("base64"));
    }
    expect(resolved.messages.map((message) => message.text)).toContainEqual(expect.stringMatching(/^Could not embed 6 image references/));
  });

  it("embeds build assets only within the private build output directory", async () => {
    const root = workspace({
      ".zeros/design-styles/app.css": ".hero { background: url(./dot.png), url(../private.png); }",
      ".zeros/design-styles/dot.png": "build-image",
      ".zeros/private.png": "private-image",
    });
    const resolved = await resolveDesignStyleSource(root, declaration({ kind: "build", path: ".zeros/design-styles/app.css" }));
    expect(resolved.css).toContain(`data:image/png;base64,${Buffer.from("build-image").toString("base64")}`);
    expect(resolved.css).not.toContain(Buffer.from("private-image").toString("base64"));
  });

  it("rejects a cached image when its parent link moves into private repository state", async () => {
    const root = workspace({
      "styles/app.css": ".hero { background: url(./linked/dot.png); }",
      "public/dot.png": "image",
      ".git/dot.png": "state",
    });
    const date = new Date(1_700_000_000_000);
    for (const file of ["public/dot.png", ".git/dot.png"]) utimesSync(path.join(root, file), date, date);
    const link = path.join(root, "styles/linked");
    symlinkSync(path.join(root, "public"), link, "dir");
    expect((await resolveDesignStyleSource(root, declaration())).css).toContain("data:image/png");
    rmSync(link);
    symlinkSync(path.join(root, ".git"), link, "dir");
    const resolved = await resolveDesignStyleSource(root, declaration());
    expect(resolved.status).toBe("warning");
    expect(resolved.css).not.toContain("data:image/png");
  });
});

describe("compiled Sass sources", () => {
  const sass = (overrides: Partial<DesignStyleSourceDeclaration> = {}) =>
    declaration({ kind: "sass", path: "src/styles/app.scss", themes: { dark: ".dark" }, ...overrides });

  it("compiles the entry and its partials for frames, with themes and tokens", async () => {
    const root = workspace({
      "src/styles/app.scss": '@use "./tokens"; .card { padding: tokens.$gap; } .dark .card { color: white; }',
      "src/styles/_tokens.scss": "$gap: 4px; :root { --brand: rebeccapurple; } .dark { --brand: plum; }",
    });
    const status = await resolveDesignStyleSource(root, sass());
    expect(status).toMatchObject({ kind: "sass", status: "ready" });
    expect(status.messages[0]!.text).toMatch(/^Compiled with Sass \d+\.\d+\.\d+\.$/);
    expect(status.tokens).toEqual([{ name: "--brand", value: "rebeccapurple", themeValues: { dark: "plum" } }]);
    const [frame] = await frameStyleSources(root, canvas([{ id: "app", kind: "sass", path: "src/styles/app.scss", themes: { dark: ".dark" } }]), "page/home.html");
    expect(frame!.css).toContain("padding: 4px");
    expect(frame!.css).toContain('[data-zd-theme="dark"] .card');
    // Editing a partial gives the source a new revision.
    writeFileSync(path.join(root, "src/styles/_tokens.scss"), "$gap: 8px; :root { --brand: rebeccapurple; } .dark { --brand: plum; }");
    utimesSync(path.join(root, "src/styles/_tokens.scss"), new Date(), new Date(Date.now() + 5_000));
    const edited = await resolveDesignStyleSource(root, sass());
    expect(edited.revision).not.toBe(status.revision);
    expect(edited.css).toContain("padding: 8px");
  });

  it("waits for setup to install a package, then compiles without a restart", async () => {
    const root = workspace({ "src/styles/app.scss": '@use "brand"; .x { order: 1; }' });
    const missing = await resolveDesignStyleSource(root, sass({ themes: {} }));
    expect(missing).toMatchObject({ status: "error", css: null });
    expect(missing.messages.map((message) => message.text)).toContain(
      "brand is not installed in this workspace. Run the workspace setup or install its dependencies, then press Update.",
    );
    mkdirSync(path.join(root, "node_modules/brand"), { recursive: true });
    writeFileSync(path.join(root, "node_modules/.modules.yaml"), "layoutVersion: 5\n");
    writeFileSync(path.join(root, "node_modules/brand/package.json"), JSON.stringify({ sass: "_index.scss" }));
    writeFileSync(path.join(root, "node_modules/brand/_index.scss"), ".brand { order: 2; }");
    const installed = await resolveDesignStyleSource(root, sass({ themes: {} }));
    expect(installed.status).toBe("ready");
    expect(installed.css).toContain(".brand");
  });

  it("names a Sass entry by its extension", async () => {
    const root = workspace({ "src/app.css": ".x{}" });
    const status = await resolveDesignStyleSource(root, sass({ path: "src/app.css" }));
    expect(status.messages[0]!.text).toBe("A Sass source names a .scss or .sass file.");
  });
});

describe("compiled Tailwind sources", () => {
  const entry = [
    '@import "tailwindcss" source(none);',
    '@import "./brand.css";',
    '@plugin "@tailwindcss/typography";',
    "@theme inline { --color-surface: var(--bg2); }",
    ':root { --bg2: 2px; } [data-theme="light"] { --bg2: 3px; }',
  ].join("\n");
  const tailwind = (overrides: Partial<DesignStyleSourceDeclaration> = {}) =>
    declaration({ kind: "tailwind", themes: { light: '[data-theme="light"]' }, ...overrides });
  const document = () => canvas([{ id: "app", kind: "tailwind", path: "styles/app.css", themes: { light: '[data-theme="light"]' } }]);

  it("builds each frame's own utilities, with the source's themes mapped", async () => {
    const root = workspace({ "styles/app.css": entry, "styles/brand.css": ".brand { order: 1; }" });
    const [home] = await frameStyleSources(root, document(), "page/home.html", { html: '<main class="bg-surface p-3 brand">' });
    const [other] = await frameStyleSources(root, document(), "page/other.html", { html: '<main class="m-4">' });
    expect(home!.css).toContain(".bg-surface");
    expect(home!.css).toContain(".p-3");
    expect(home!.css).toContain('[data-zd-theme="light"]');
    expect(home!.css).toContain(".brand");
    expect(home!.css).not.toContain(".m-4");
    expect(other!.css).not.toContain(".p-3");
    // Imported plain CSS reaches only the frames that use it.
    expect(other!.css).not.toContain(".brand");
    expect(home!.revision).not.toBe(other!.revision);
  });

  it("reports the compile, what it skipped, and the application's own tokens", async () => {
    const root = workspace({ "styles/app.css": entry, "styles/brand.css": ":root { --brand: 1px; }" });
    const status = await resolveDesignStyleSource(root, tailwind());
    expect(status).toMatchObject({ kind: "tailwind", status: "ready", css: null, revision: expect.stringMatching(/^[a-f0-9]{24}$/) });
    expect(status.messages).toEqual([
      { level: "info", text: expect.stringMatching(/^Compiled with Tailwind CSS 4\.\d+\.\d+ for the classes each frame uses\.$/) },
      { level: "info", text: expect.stringMatching(/^Ran Zeros' own @tailwindcss\/typography \d+\.\d+\.\d+; the application's installed version may differ\.$/) },
    ]);
    const names = status.tokens.map((token) => token.name).sort();
    expect(names).toEqual(["--bg2", "--brand", "--color-surface"]);
    expect(status.tokens.find((token) => token.name === "--bg2")).toEqual({ name: "--bg2", value: "2px", themeValues: { light: "3px" } });
  });

  it("gives identity without compiling, and a new revision when an imported file changes", async () => {
    const root = workspace({ "styles/app.css": entry, "styles/brand.css": ".brand { order: 1; }" });
    const html = '<main class="p-3 brand">';
    const [identity] = await frameStyleSources(root, document(), "page/home.html", { html, build: false });
    const [built] = await frameStyleSources(root, document(), "page/home.html", { html });
    // Tailwind is not compiled for identity, so its size is unknown.
    expect(identity).toEqual({ id: "app", css: "", revision: built!.revision, bytes: 0 });
    writeFileSync(path.join(root, "styles/brand.css"), ".brand { order: 2; }");
    utimesSync(path.join(root, "styles/brand.css"), new Date(), new Date(Date.now() + 5_000));
    const [edited] = await frameStyleSources(root, document(), "page/home.html", { html });
    expect(edited!.revision).not.toBe(built!.revision);
    expect(edited!.css).toContain("order: 2");
  });

  it("embeds fonts that imported package stylesheets declare", async () => {
    const font = Buffer.from("wOF2 fixture font");
    const root = workspace({
      "styles/app.css": '@import "tailwindcss"; @import "brand-font";',
      "node_modules/brand-font/package.json": JSON.stringify({ style: "index.css" }),
      "node_modules/brand-font/index.css": "@font-face { font-family: Brand; src: url(./files/brand.woff2) format('woff2'); }",
    });
    mkdirSync(path.join(root, "node_modules/brand-font/files"));
    writeFileSync(path.join(root, "node_modules/brand-font/files/brand.woff2"), font);
    const [frame] = await frameStyleSources(root, document(), "page/home.html", { html: '<main style="font-family: Brand"></main>' });
    expect(frame!.css).toContain(`url("data:font/woff2;base64,${font.toString("base64")}") format('woff2')`);
    // A frame that never names the family does not carry it.
    const [plain] = await frameStyleSources(root, document(), "page/home.html", { html: "<main></main>" });
    expect(plain!.css).not.toContain("@font-face");
  });

  it("says why each import was skipped, so the person knows what to do", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "zeros-style-outside-"));
    roots.push(outside);
    mkdirSync(path.join(outside, "linked"), { recursive: true });
    writeFileSync(path.join(outside, "linked/package.json"), JSON.stringify({ style: "index.css" }));
    writeFileSync(path.join(outside, "linked/index.css"), ".linked { order: 1; }");
    const root = workspace({
      "styles/app.css": '@import "tailwindcss"; @import "tw-animate-css"; @import "linked"; @import "./gone.css"; @import "@/styles/x.css";',
    });
    mkdirSync(path.join(root, "node_modules"));
    symlinkSync(path.join(outside, "linked"), path.join(root, "node_modules/linked"));
    const status = await resolveDesignStyleSource(root, tailwind({ themes: {} }));
    expect(status.status).toBe("warning");
    expect(status.messages.map((message) => message.text)).toEqual([
      expect.stringMatching(/^Compiled with Tailwind CSS/),
      "Could not import @/styles/x.css: it uses a path alias that only the application's bundler understands; import it with a relative path.",
      "Could not import ./gone.css: it does not exist.",
      "tw-animate-css is not installed in this workspace. Run the workspace setup or install its dependencies, then press Update.",
      "Could not import linked: it resolves outside this checkout, through a linked package or a shared package store. Frames read only files inside the checkout.",
    ]);
  });

  describe("while the workspace setup installs dependencies", () => {
    let setup: DesignWorkspaceSetupState = null;
    afterEach(() => configureDesignStyleBuilds(null));
    const host = () => configureDesignStyleBuilds({
      boundaryFactory: async () => { throw new Error("no builds in this test"); },
      changed: () => undefined,
      setupState: () => setup,
    });

    it("waits for setup, then recovers once the package is installed, without a restart", async () => {
      host();
      setup = "running";
      const root = workspace({ "styles/app.css": '@import "tailwindcss"; @import "tw-animate-css";' });
      const waiting = await resolveDesignStyleSource(root, tailwind({ themes: {} }));
      expect(waiting.status).toBe("warning");
      expect(waiting.messages[1]).toEqual({ level: "warning", text: "Waiting for the workspace setup to install tw-animate-css.", action: "update" });
      setup = "failed";
      expect((await resolveDesignStyleSource(root, tailwind({ themes: {} }))).messages[1]!.text).toBe(
        "tw-animate-css is not installed because the workspace setup failed. Rerun setup, then press Update.",
      );
      setup = "passed";
      mkdirSync(path.join(root, "node_modules/tw-animate-css"), { recursive: true });
      writeFileSync(path.join(root, "node_modules/tw-animate-css/package.json"), JSON.stringify({ exports: { ".": { style: "./dist/tw-animate.css" } } }));
      mkdirSync(path.join(root, "node_modules/tw-animate-css/dist"));
      writeFileSync(path.join(root, "node_modules/tw-animate-css/dist/tw-animate.css"), ".animate-in { order: 1; }");
      const installed = await resolveDesignStyleSource(root, tailwind({ themes: {} }));
      expect(installed.status).toBe("ready");
      expect(installed.messages).toHaveLength(1);
      const [frame] = await frameStyleSources(root, canvas([{ id: "app", kind: "tailwind", path: "styles/app.css" }]), "page/home.html", { html: '<main class="animate-in"></main>' });
      expect(frame!.css).toContain(".animate-in");
    });

    it("treats a declared package file as waiting, not broken, while setup runs", async () => {
      host();
      setup = "running";
      const root = workspace();
      const status = await resolveDesignStyleSource(root, declaration({ path: "node_modules/@fontsource-variable/geist/index.css" }));
      expect(status).toMatchObject({ status: "warning", css: null, revision: null });
      expect(status.messages).toEqual([{ level: "warning", text: "Waiting for the workspace setup to install node_modules/@fontsource-variable/geist/index.css.", action: "update" }]);
    });
  });

  it("fails closed when the entry does not compile", async () => {
    const root = workspace({ "styles/app.css": "@import \"tailwindcss\"; .a { @apply not-a-utility; }" });
    const status = await resolveDesignStyleSource(root, tailwind());
    expect(status).toMatchObject({ status: "error", revision: null });
    expect(status.messages[0]!.text).toMatch(/^Tailwind could not compile styles\/app\.css: /);
    expect(await frameStyleSources(root, document(), "page/home.html", { html: "<main></main>" })).toEqual([]);
  });
});

describe("App fonts", () => {
  const INTER = "https://fonts.googleapis.com/css2?family=Inter:wght@400&display=swap";
  const font = Buffer.from("wOF2 fixture font");
  let calls: string[] = [];
  let ready: string[][] = [];

  /** Mocked Google Fonts; downloads wait until the returned release runs. */
  function fonts(): () => void {
    const cache = workspace();
    calls = [];
    ready = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    configureDesignFonts({
      cacheDirectory: () => path.join(cache, "fonts"),
      onReady: (roots) => ready.push([...roots]),
      fetch: (async (input: string | URL | Request) => {
        const url = String(input);
        calls.push(url);
        await held;
        if (url.startsWith("https://fonts.googleapis.com/")) {
          return new Response("/* latin */\n@font-face { font-family: 'Acme'; src: url(https://fonts.gstatic.com/s/inter/latin.woff2) format('woff2'); }");
        }
        return new Response(new Uint8Array(font));
      }) as typeof fetch,
    });
    return release;
  }
  afterEach(async () => {
    await settleDesignFontDownloadsForTests();
    resetDesignFontsForTests();
  });

  it("embeds a source's Google Fonts import instead of warning about it", async () => {
    const release = fonts();
    const root = workspace({ "styles/app.css": `@import url("${INTER}"); @import url("https://cdn.example/x.css"); body { font-family: Acme, sans-serif; }` });
    const document = canvas([{ id: "app", kind: "css", path: "styles/app.css" }], { "page/home.html": {}, "page/plain.html": { styles: [] } } as unknown as CanvasDocument["frame_info"]);
    const first = await readDesignStyleSources(root, document);
    expect(first.sources.map((source) => source.id)).toEqual(["@fonts", "app"]);
    expect(first.sources[0]).toMatchObject({
      title: "App fonts",
      kind: "fonts",
      status: "ready",
      messages: [{ level: "info", text: "Downloading Inter from Google Fonts; frames use the fallback font until it arrives." }],
      revision: null,
    });
    // Only the non-font import still warns.
    expect(first.sources[1]!.messages.map((message) => message.text).join(" ")).not.toContain("fonts.googleapis.com");
    expect(first.sources[1]!.messages.map((message) => message.text).join(" ")).toContain("https://cdn.example/x.css");
    expect(await frameStyleSources(root, document, "page/home.html")).toEqual([expect.objectContaining({ id: "app" })]);

    release();
    await settleDesignFontDownloadsForTests();
    expect(ready).toEqual([[path.resolve(root)]]);
    const second = await readDesignStyleSources(root, document);
    expect(second.sources[0]!.messages).toEqual([
      { level: "info", text: "Embeds Inter from Google Fonts (1 KB), downloaded once for this machine." },
    ]);
    const [fontsSheet, app] = await frameStyleSources(root, document, "page/home.html");
    expect(fontsSheet).toMatchObject({ id: "@fonts", revision: second.sources[0]!.revision });
    expect(fontsSheet!.css).toContain(`url("data:font/woff2;base64,${font.toString("base64")}")`);
    expect(app!.id).toBe("app");
    // Identity reads stay cheap and network-free.
    const [identity] = await frameStyleSources(root, document, "page/home.html", { build: false });
    expect(identity).toEqual({ id: "@fonts", css: "", revision: fontsSheet!.revision });
    expect(calls).toEqual([INTER, "https://fonts.gstatic.com/s/inter/latin.woff2"]);
    // A frame that opts out of every source gets no fonts either.
    expect(await frameStyleSources(root, document, "page/plain.html")).toEqual([]);
  });

  it("embeds declared local fonts and sets their variables, without any style source", async () => {
    fonts()();
    const root = workspace({ "public/fonts/Brand.woff2": "" });
    writeFileSync(path.join(root, "public/fonts/Brand.woff2"), font);
    const document = {
      ...canvas(undefined),
      fonts: [
        { family: "Brand", provider: "local", path: "public/fonts/Brand.woff2", variable: "--font-brand", weight: "700", fallback: "serif" },
        { family: "Gone", provider: "local", path: "public/fonts/Gone.woff2" },
        { family: "Bad", provider: "local", path: "/etc/font.woff2" },
      ],
    } as CanvasDocument;
    const status = await readDesignStyleSources(root, document);
    expect(status.errors).toEqual(['Font "Bad": a local font names a .woff2, .woff, .ttf or .otf file inside the repository.']);
    expect(status.sources).toHaveLength(1);
    expect(status.sources[0]).toMatchObject({
      id: "@fonts",
      status: "warning",
      tokens: [{ name: "--font-brand", value: '"Brand", serif', themeValues: {} }],
      messages: [
        { level: "info", text: "Embeds Brand from this repository." },
        { level: "warning", action: "agent", text: "Could not embed public/fonts/Gone.woff2 (it does not exist)." },
      ],
    });
    const [sheet] = await frameStyleSources(root, document, "page/home.html");
    expect(sheet!.css).toContain(`@font-face { font-family: "Brand"; src: url("data:font/woff2;base64,${font.toString("base64")}") format("woff2"); font-weight: 700;`);
    expect(sheet!.css).toContain(':root { --font-brand: "Brand", serif; }');
    expect(calls).toEqual([]);
    // Editing the font file gives frames a new revision.
    writeFileSync(path.join(root, "public/fonts/Brand.woff2"), Buffer.concat([font, Buffer.from([1])]));
    utimesSync(path.join(root, "public/fonts/Brand.woff2"), new Date(), new Date(Date.now() + 5_000));
    const [edited] = await frameStyleSources(root, document, "page/home.html");
    expect(edited!.revision).not.toBe(sheet!.revision);
  });

  it("offers Update when a download failed, and Update retries it", async () => {
    fonts()();
    configureDesignFonts({ fetch: (async () => new Response("down", { status: 503 })) as unknown as typeof fetch });
    const root = workspace();
    const document = { ...canvas(undefined), fonts: [{ family: "Geist", provider: "google", variable: "--font-geist-sans" }] } as CanvasDocument;
    await readDesignStyleSources(root, document);
    await settleDesignFontDownloadsForTests();
    const failed = await readDesignStyleSources(root, document);
    expect(failed.sources[0]).toMatchObject({
      status: "warning",
      messages: [{ level: "warning", action: "update", text: "Could not download Geist from Google Fonts: Google Fonts answered 503. Frames use the fallback font; press Update to retry." }],
    });
    // The variable still names the family, so the fallback applies meanwhile.
    const [sheet] = await frameStyleSources(root, document, "page/home.html");
    expect(sheet!.css).toBe(':root { --font-geist-sans: "Geist", sans-serif; }');
  });
});
