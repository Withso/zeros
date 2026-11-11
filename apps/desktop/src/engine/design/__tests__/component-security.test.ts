import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The code that reads and evaluates authored component options and templates.
const FILES = [
  "../../../../../../packages/design-core/src/component-expressions.ts",
  "../../../../../../packages/design-core/src/component-options.ts",
  "../../../../../../packages/design-web/src/component-options.ts",
  "../component-template.ts",
  "../component-registry.ts",
  "../component-last-good.ts",
];
const source = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

describe("component options run no authored code", () => {
  it.each(FILES)("%s has no eval, Function, dynamic import or host access", (file) => {
    const code = source(file);
    expect(code).not.toMatch(/\beval\s*\(/);
    expect(code).not.toMatch(/\bnew\s+Function\b|\bFunction\s*\(/);
    expect(code).not.toMatch(/\bimport\s*\(/);
    expect(code).not.toMatch(/\b(?:globalThis|window|process|require)\s*[.[(]/);
    expect(code).not.toMatch(/\bwith\s*\(/);
  });

  it.each(FILES)("%s builds no regular expression from authored text", (file) => {
    for (const match of source(file).matchAll(/new\s+RegExp\(([^;]*)\)/g)) {
      // Only patterns assembled from this module's own constants.
      expect(match[1], file).toMatch(/^`[^`]*\$\{DECIMAL\}[^`]*`$/);
    }
  });
});
