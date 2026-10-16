import { describe, expect, it } from "vitest";
import { compileDesignSass, DesignSassImportError } from "../style-sass";
import type { TailwindFileReader } from "../style-tailwind";

const reader = (files: Record<string, string>): TailwindFileReader & { reads: string[] } => {
  const reads: string[] = [];
  return Object.assign(async (file: string) => {
    reads.push(file);
    return files[file] ?? null;
  }, { reads });
};

async function problems(entry: string, files: Record<string, string>, options: Parameters<typeof compileDesignSass>[2] = {}) {
  try {
    await compileDesignSass({ file: "src/styles/app.scss", content: entry }, reader(files), options);
  } catch (error) {
    if (error instanceof DesignSassImportError) return error.skipped;
    throw error;
  }
  return [];
}

describe("compiling a Sass source", () => {
  it("follows relative partials, plain local names and Sass modules", async () => {
    const read = reader({
      "src/styles/_tokens.scss": "$gap: 4px; :root { --brand: rebeccapurple; }",
      "src/styles/base/_index.scss": ".base { margin: 0; }",
      "src/styles/_legacy.scss": ".legacy { order: 1; }",
    });
    const entry = '@use "sass:math"; @use "./tokens"; @use "base"; @import "legacy"; .card { padding: math.div(tokens.$gap, 2); .title { color: var(--brand); } }';
    const result = await compileDesignSass({ file: "src/styles/app.scss", content: entry }, read);
    expect(result.css).toContain("--brand: rebeccapurple");
    expect(result.css).toContain(".base");
    expect(result.css).toContain(".legacy");
    expect(result.css).toContain("padding: 2px");
    expect(result.css).toContain(".card .title");
    expect(result.files).toEqual(["src/styles/_legacy.scss", "src/styles/_tokens.scss", "src/styles/app.scss", "src/styles/base/_index.scss"]);
  });

  it("resolves packages through pkg:, bare names and webpack's ~ inside node_modules", async () => {
    const read = reader({
      "node_modules/brand/package.json": JSON.stringify({ sass: "scss/_index.scss" }),
      "node_modules/brand/scss/_index.scss": ".brand { order: 1; }",
      "node_modules/kit/package.json": JSON.stringify({ name: "kit" }),
      "node_modules/kit/scss/_functions.scss": "@function double($n) { @return $n * 2; }",
      "node_modules/legacy/package.json": JSON.stringify({ exports: { "./theme": { sass: "./src/theme.scss" } } }),
      "node_modules/legacy/src/theme.scss": ".legacy-theme { order: 3; }",
    });
    const entry = '@use "pkg:brand"; @use "kit/scss/functions"; @import "~legacy/theme"; .x { width: functions.double(2px); }';
    const result = await compileDesignSass({ file: "src/styles/app.scss", content: entry }, read);
    expect(result.css).toContain(".brand");
    expect(result.css).toContain(".legacy-theme");
    expect(result.css).toContain("width: 4px");
  });

  it("keeps a remote @import as plain CSS, for the CSS import step to report", async () => {
    const result = await compileDesignSass({ file: "src/app.scss", content: '@import "https://fonts.example/a.css"; .x { order: 1; }' }, reader({}));
    expect(result.css).toContain('@import "https://fonts.example/a.css"');
  });

  it("compiles the indented syntax", async () => {
    const result = await compileDesignSass({ file: "src/app.sass", content: ".card\n  padding: 4px\n  .title\n    color: red\n" }, reader({}));
    expect(result.css).toContain(".card .title");
  });

  it("says why an import failed, without reading outside the checkout", async () => {
    // Sass drops the leading "./" before asking importers.
    expect(await problems('@use "./missing";', {})).toEqual([{ id: "missing", problem: "missing" }]);
    expect(await problems('@use "../../../../etc/passwd";', {})).toEqual([{ id: "../../../../etc/passwd", problem: "missing" }]);
    expect(await problems('@use "bootstrap";', {}, { installed: async () => false })).toEqual([{ id: "bootstrap", problem: "not-installed" }]);
    expect(await problems('@use "variables";', {}, { installed: async () => true })).toEqual([{ id: "variables", problem: "missing" }]);
    expect(await problems('@use "https://fonts.example/a";', {})).toEqual([{ id: "https://fonts.example/a", problem: "remote" }]);
    expect(await problems('@use "@/styles/x";', {})).toEqual([{ id: "@/styles/x", problem: "alias" }]);
    expect(await problems('@use "linked";', {}, { diagnose: async (file) => (file.startsWith("node_modules/linked/") ? "outside" : "missing") }))
      .toEqual([{ id: "linked", problem: "outside" }]);
  });
});
