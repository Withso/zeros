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
    const entry = '@import "tailwindcss"; @plugin "@tailwindcss/typography"; @config "./tailwind.config.js"; @import "https://fonts.example/a.css"; @import "../../outside.css"; @import "./missing.css"; @source inline("underline");';
    const compiler = await compileDesignTailwind({ file: "styles/app.css", content: entry }, reader({}));
    const css = compiler.build([]);
    expect(css).toContain(".underline");
    expect(compiler.skippedModules).toEqual(["@config ./tailwind.config.js", "@plugin @tailwindcss/typography"]);
    expect(compiler.skippedImports).toEqual(["../../outside.css", "./missing.css"]);
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
    expect(compiler.skippedImports).toEqual(["absent"]);
  });

  it("starts every frame from a fresh compile, so one frame's classes never reach another", async () => {
    const entry = { file: "app.css", content: '@import "tailwindcss";' };
    const first = await compileDesignTailwind(entry, reader({}));
    first.build(["m-4"]);
    const second = await compileDesignTailwind(entry, reader({}));
    expect(second.build(["p-2"])).not.toContain(".m-4");
  });
});
