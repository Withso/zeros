import { describe, expect, it } from "vitest";
import { compileDesignTailwind, designTailwindCandidates, type TailwindFileReader } from "../style-tailwind";

const reader = (files: Record<string, string>): TailwindFileReader & { reads: string[] } => {
  const reads: string[] = [];
  return Object.assign(async (file: string) => {
    reads.push(file);
    return files[file] ?? null;
  }, { reads });
};

describe("Tailwind candidates", () => {
  it("collects class tokens and the custom properties frame CSS reads", () => {
    expect(designTailwindCandidates(
      '<main class="p-3  bg-bg2 p-3"><svg class="size-4"></svg><p style="color: var( --fg2 )">x</p><template><b class="hidden"></b></template></main><style>.x { gap: var(--space-3); }</style>',
    )).toEqual(["--fg2", "--space-3", "bg-bg2", "hidden", "p-3", "size-4"]);
  });
});

describe("compiling a Tailwind entry", () => {
  it("builds the frame's utilities with the bundled Tailwind and repository CSS imports", async () => {
    const read = reader({
      "styles/app.css": '@import "tailwindcss" source(none); @import "./brand.css"; @theme { --color-brand: var(--brand); } @custom-variant dark (&:is([data-theme="dark"] *));',
      "styles/brand.css": ".brand-card { padding: 3px; }",
    });
    const compiler = await compileDesignTailwind({ file: "styles/app.css", content: (await read("styles/app.css"))! }, read);
    const css = compiler.build(["bg-brand", "dark:p-1", "unknown-class"]);
    expect(css).toContain(".bg-brand");
    expect(css).toContain("--color-brand: var(--brand)");
    expect(css).toContain('[data-theme="dark"]');
    expect(css).toContain(".brand-card { padding: 3px; }".replace(" { ", " {\n  ").replace("; }", ";\n}"));
    expect(css).not.toContain("unknown-class");
    expect(compiler.imports).toEqual(["styles/brand.css"]);
    expect(compiler.skippedImports).toEqual([]);
  });

  it("replaces plugins and configs with empty modules and skips imports outside the repository", async () => {
    const entry = '@import "tailwindcss"; @plugin "@acme/tailwind-plugin"; @config "./tailwind.config.js"; @import "https://fonts.example/a.css"; @import "../../outside.css"; @import "./missing.css"; @source inline("underline");';
    const compiler = await compileDesignTailwind({ file: "styles/app.css", content: entry }, reader({}));
    const css = compiler.build([]);
    expect(css).toContain(".underline");
    expect(compiler.skippedModules).toEqual(["@config ./tailwind.config.js", "@plugin @acme/tailwind-plugin"]);
    expect(compiler.skippedImports).toEqual([
      { id: "../../outside.css", problem: "outside" },
      { id: "./missing.css", problem: "missing" },
    ]);
    // Tailwind leaves remote imports in its output; the style source drops them.
    expect(css).toContain("https://fonts.example/a.css");
  });

  it("resolves package stylesheets through exports, style, a CSS main or index.css", async () => {
    const read = reader({
      "node_modules/exported/package.json": JSON.stringify({ exports: { ".": { sass: "./x.scss", style: "./dist/exported.css" }, "./*": { default: "./parts/*.css" } } }),
      "node_modules/exported/dist/exported.css": ".exported { order: 1; }",
      "node_modules/exported/parts/extra.css": ".extra { order: 2; }",
      "node_modules/@scope/styled/package.json": JSON.stringify({ style: "styled.css", main: "index.js" }),
      "node_modules/@scope/styled/styled.css": ".styled { order: 3; }",
      "node_modules/plain/package.json": JSON.stringify({ main: "index.js" }),
      "node_modules/plain/index.css": ".plain { order: 4; }",
      "apps/web/node_modules/local/package.json": JSON.stringify({ main: "local.css" }),
      "apps/web/node_modules/local/local.css": ".local { order: 5; }",
    });
    const entry = '@import "tailwindcss"; @import "exported"; @import "exported/extra"; @import "@scope/styled"; @import "plain"; @import "local"; @import "absent";';
    const compiler = await compileDesignTailwind({ file: "apps/web/app.css", content: entry }, read);
    const css = compiler.build([]);
    for (const rule of [".exported", ".extra", ".styled", ".plain", ".local"]) expect(css).toContain(rule);
    expect(compiler.imports).toEqual([
      "apps/web/node_modules/local/local.css",
      "node_modules/@scope/styled/styled.css",
      "node_modules/exported/dist/exported.css",
      "node_modules/exported/parts/extra.css",
      "node_modules/plain/index.css",
    ]);
    expect(compiler.skippedImports).toEqual([{ id: "absent", problem: "not-installed" }]);
  });

  it.each(["dark", "themes/dark", "$&", "$$"])("replaces every export-target wildcard with the literal subpath %s", async (subpath) => {
    const target = `node_modules/patterned/styles/${subpath}/theme-${subpath}.css`;
    const read = reader({
      "node_modules/patterned/package.json": JSON.stringify({
        exports: { "./themes/*.css": { style: "./styles/*/theme-*.css" } },
      }),
      [target]: ".patterned { order: 7; }",
    });
    const compiler = await compileDesignTailwind({
      file: "styles/app.css",
      content: `@import "patterned/themes/${subpath}.css";`,
    }, read);
    expect(compiler.imports).toEqual([target]);
    expect(compiler.skippedImports).toEqual([]);
    expect(compiler.build([])).toContain(".patterned");
  });

  it("rejects patterned export targets outside their package", async () => {
    const outside = "node_modules/outside/dark/dark.css";
    const read = reader({
      "node_modules/patterned/package.json": JSON.stringify({ exports: { "./*": "../outside/*/*.css" } }),
      [outside]: ".outside { order: 8; }",
    });
    const compiler = await compileDesignTailwind({ file: "styles/app.css", content: '@import "patterned/dark";' }, read);
    expect(compiler.imports).toEqual([]);
    expect(compiler.skippedImports).toEqual([{ id: "patterned/dark", problem: "outside" }]);
    expect(read.reads).not.toContain(outside);
    expect(compiler.build([])).not.toContain(".outside");
  });

  it("says why each import it could not follow was skipped", async () => {
    const read = reader({
      "node_modules/js-only/package.json": JSON.stringify({ main: "index.js", exports: { ".": { import: "./index.mjs" } } }),
      "node_modules/scripted/package.json": JSON.stringify({ exports: { ".": "./index.js" } }),
      "node_modules/broken/package.json": JSON.stringify({ style: "dist/broken.css" }),
      "node_modules/webpack-style/package.json": JSON.stringify({ style: "theme.css" }),
      "node_modules/webpack-style/theme.css": ".webpack-style { order: 1; }",
    });
    // Links stored outside the checkout exist but are refused by the reader.
    const diagnose = async (file: string) => (file.startsWith("node_modules/linked/") ? "outside" as const : "missing" as const);
    const entry = [
      '@import "tailwindcss";',
      '@import "/styles/absolute.css";',
      '@import "@/styles/alias.css";',
      '@import "~/styles/home.css";',
      '@import "#styles/subpath.css";',
      '@import "//cdn.example/remote.css";',
      '@import "js-only";',
      '@import "scripted";',
      '@import "broken";',
      '@import "linked";',
      '@import "not-installed";',
      '@import "~webpack-style";',
    ].join(" ");
    const compiler = await compileDesignTailwind({ file: "styles/app.css", content: entry }, read, diagnose);
    expect(compiler.skippedImports).toEqual([
      { id: "#styles/subpath.css", problem: "alias" },
      { id: "//cdn.example/remote.css", problem: "remote" },
      { id: "/styles/absolute.css", problem: "absolute" },
      { id: "@/styles/alias.css", problem: "alias" },
      { id: "broken", problem: "missing" },
      { id: "js-only", problem: "not-css" },
      { id: "linked", problem: "outside" },
      { id: "not-installed", problem: "not-installed" },
      { id: "scripted", problem: "not-css" },
      { id: "~/styles/home.css", problem: "alias" },
    ]);
    expect(compiler.imports).toEqual(["node_modules/webpack-style/theme.css"]);
    expect(compiler.build([])).toContain(".webpack-style");
  });

  it("runs Zeros' own copies of the official plugins, never the repository's, and skips the rest", async () => {
    const entry = '@import "tailwindcss"; @plugin "@tailwindcss/typography"; @plugin "@tailwindcss/forms"; @plugin "tailwindcss-animate"; @plugin "daisyui";';
    const compiler = await compileDesignTailwind({ file: "styles/app.css", content: entry }, reader({}));
    expect(compiler.bundledModules).toEqual(["@plugin @tailwindcss/forms", "@plugin @tailwindcss/typography", "@plugin tailwindcss-animate"]);
    expect(compiler.skippedModules).toEqual(["@plugin daisyui"]);
    const css = compiler.build(["prose", "form-input", "animate-in", "fade-in"]);
    expect(css).toContain(".prose");
    expect(css).toContain(".form-input");
    expect(css).toContain(".animate-in");
  });

  it("starts every frame from a fresh compile, so one frame's classes never reach another", async () => {
    const entry = { file: "app.css", content: '@import "tailwindcss";' };
    const first = await compileDesignTailwind(entry, reader({}));
    first.build(["m-4"]);
    const second = await compileDesignTailwind(entry, reader({}));
    expect(second.build(["p-2"])).not.toContain(".m-4");
  });
});
