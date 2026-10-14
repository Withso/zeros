import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CanvasDocument } from "../document-model";
import {
  MAX_DESIGN_STYLE_SOURCE_FONT_BYTES,
  designStyleSourcePathError,
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
      .toEqual([{ level: "warning", text: 'Theme "light": no rule uses the selector .light.' }]);
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

  it("fails closed for unsupported kinds, missing files, symlinks and invalid CSS", async () => {
    const root = workspace({ "outside.css": ":root{}", "styles/broken.css": ".a { color: red" });
    symlinkSync(path.join(root, "outside.css"), path.join(root, "styles/link.css"));
    for (const [overrides, text] of [
      [{ kind: "less" }, /not available/],
      [{ path: "styles/missing.css" }, /missing, outside the repository, a symlink/],
      [{ path: "styles/link.css" }, /missing, outside the repository, a symlink/],
      [{ path: "node_modules/@fontsource-variable/geist/index.css" }, /Install the repository's dependencies/],
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
      { level: "info", text: "Embeds 2 font files (1 KB) in each frame that uses this source." },
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
        text: "Could not embed 4 font references: https://fonts.example/a.woff2, missing.woff2, ../../outside.woff2 and 1 more. Only .woff2, .woff, .ttf and .otf files inside the repository can be embedded, up to 4 MiB per source. Frames use the next font in each font-family list instead.",
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
      "Embeds 1 font file (4096 KB) in each frame that uses this source.",
      expect.stringMatching(/^Could not embed 1 font reference: b\.woff2\. .*4 MiB/),
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
    const [home] = await frameStyleSources(root, document(), "page/home.html", { html: '<main class="bg-surface p-3">' });
    const [other] = await frameStyleSources(root, document(), "page/other.html", { html: '<main class="m-4">' });
    expect(home!.css).toContain(".bg-surface");
    expect(home!.css).toContain(".p-3");
    expect(home!.css).toContain('[data-zd-theme="light"]');
    expect(home!.css).toContain(".brand");
    expect(home!.css).not.toContain(".m-4");
    expect(other!.css).not.toContain(".p-3");
    expect(home!.revision).not.toBe(other!.revision);
  });

  it("reports the compile, what it skipped, and the application's own tokens", async () => {
    const root = workspace({ "styles/app.css": entry, "styles/brand.css": ":root { --brand: 1px; }" });
    const status = await resolveDesignStyleSource(root, tailwind());
    expect(status).toMatchObject({ kind: "tailwind", status: "warning", css: null, revision: expect.stringMatching(/^[a-f0-9]{24}$/) });
    expect(status.messages).toEqual([
      { level: "info", text: expect.stringMatching(/^Compiled with Tailwind CSS 4\.\d+\.\d+ for the classes each frame uses\.$/) },
      { level: "warning", text: "Did not run @plugin @tailwindcss/typography: plugins and JavaScript configs execute code, so what they add is missing from frames." },
    ]);
    const names = status.tokens.map((token) => token.name).sort();
    expect(names).toEqual(["--bg2", "--brand", "--color-surface"]);
    expect(status.tokens.find((token) => token.name === "--bg2")).toEqual({ name: "--bg2", value: "2px", themeValues: { light: "3px" } });
  });

  it("gives identity without compiling, and a new revision when an imported file changes", async () => {
    const root = workspace({ "styles/app.css": entry, "styles/brand.css": ".brand { order: 1; }" });
    const html = '<main class="p-3">';
    const [identity] = await frameStyleSources(root, document(), "page/home.html", { html, build: false });
    const [built] = await frameStyleSources(root, document(), "page/home.html", { html });
    expect(identity).toEqual({ id: "app", css: "", revision: built!.revision });
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
    const [frame] = await frameStyleSources(root, document(), "page/home.html", { html: "<main></main>" });
    expect(frame!.css).toContain(`url("data:font/woff2;base64,${font.toString("base64")}") format('woff2')`);
  });

  it("fails closed when the entry does not compile", async () => {
    const root = workspace({ "styles/app.css": "@import \"tailwindcss\"; .a { @apply not-a-utility; }" });
    const status = await resolveDesignStyleSource(root, tailwind());
    expect(status).toMatchObject({ status: "error", revision: null });
    expect(status.messages[0]!.text).toMatch(/^Tailwind could not compile styles\/app\.css: /);
    expect(await frameStyleSources(root, document(), "page/home.html", { html: "<main></main>" })).toEqual([]);
  });
});
