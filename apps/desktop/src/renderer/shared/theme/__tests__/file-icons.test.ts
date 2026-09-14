import { describe, expect, it } from "vitest";
import { createFileTreeIconResolver } from "@pierre/trees";

import {
  FILE_ICON_SAMPLES,
  FILE_ICON_SPRITE,
  FILE_ICON_TOKENS,
  FILE_ICON_TREE_CONFIG,
  fileIconSymbolId,
} from "../file-icons";

const resolver = createFileTreeIconResolver(FILE_ICON_TREE_CONFIG);
const resolve = (path: string) =>
  resolver.resolveIcon("file-tree-icon-file", path).name;

describe("file-icons", () => {
  it("defines a symbol for every token, and every mapping points at one", () => {
    for (const token of FILE_ICON_TOKENS) {
      expect(FILE_ICON_SPRITE).toContain(`id="${fileIconSymbolId(token)}"`);
    }
    const ids = new Set(FILE_ICON_TOKENS.map(fileIconSymbolId));
    for (const table of [
      FILE_ICON_TREE_CONFIG.byFileName,
      FILE_ICON_TREE_CONFIG.byFileExtension,
    ]) {
      for (const id of Object.values(table ?? {}))
        expect(ids.has(id as string)).toBe(true);
    }
  });

  it("every token is reachable from some filename", () => {
    for (const token of FILE_ICON_TOKENS) {
      expect(resolve(FILE_ICON_SAMPLES[token])).toBe(fileIconSymbolId(token));
    }
  });

  it("resolves the cases the library's built-in set got wrong or missed", () => {
    // Bare LICENSE has no extension candidates — needs the filename table.
    expect(resolve("LICENSE")).toBe(fileIconSymbolId("license"));
    expect(resolve("packages/a/LICENSE.md")).toBe(fileIconSymbolId("license"));
    // Package-manager files read as npm, not generic JSON/YAML.
    expect(resolve("package.json")).toBe(fileIconSymbolId("npm"));
    expect(resolve("pnpm-lock.yaml")).toBe(fileIconSymbolId("npm"));
    expect(resolve("yarn.lock")).toBe(fileIconSymbolId("npm"));
    // …while other YAML keeps the Y.
    expect(resolve("pnpm-workspace.yaml")).toBe(fileIconSymbolId("yml"));
    // Tool config files are just source files, as in Cursor: the JS/TS glyph.
    expect(resolve("postcss.config.cjs")).toBe(fileIconSymbolId("javascript"));
    expect(resolve("svgo.config.ts")).toBe(fileIconSymbolId("typescript"));
    // …but the tools' own rc files keep their glyph.
    expect(resolve(".postcssrc")).toBe(fileIconSymbolId("postcss"));
    // Test/spec sources get the orange variants; d.ts stays plain TS.
    expect(resolve("smoke.spec.ts")).toBe(fileIconSymbolId("typescript-test"));
    expect(resolve("ui.test.tsx")).toBe(fileIconSymbolId("react-test"));
    expect(resolve("api.d.ts")).toBe(fileIconSymbolId("typescript"));
    // Settings-style files → gear; media → video/audio; favicon → star.
    expect(resolve(".env.local")).toBe(fileIconSymbolId("settings"));
    expect(resolve("railway.toml")).toBe(fileIconSymbolId("settings"));
    expect(resolve("intro.mp4")).toBe(fileIconSymbolId("video"));
    expect(resolve("favicon.svg")).toBe(fileIconSymbolId("favicon"));
    expect(resolve("cursor.svg")).toBe(fileIconSymbolId("svg"));
    expect(resolve("TODO.md")).toBe(fileIconSymbolId("todo"));
    // Filename beats extension; longest extension candidate wins.
    expect(resolve("vite.config.ts")).toBe(fileIconSymbolId("vite"));
    expect(resolve("Button.mdx.tsx")).toBe(fileIconSymbolId("markdown"));
    expect(resolve("Button.tsx")).toBe(fileIconSymbolId("react"));
    // Unknown → our default page glyph, never the library's.
    expect(resolve(".worktreeinclude")).toBe(fileIconSymbolId("default"));
    expect(resolve("Makefile")).toBe(fileIconSymbolId("default"));
  });
});
