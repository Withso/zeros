import { describe, expect, it } from "vitest";

import type { ChangedFile } from "../changes-parse";
import { filterChangeSections } from "../changes-search";

function file(path: string, oldPath?: string): ChangedFile {
  return {
    path,
    oldPath,
    status: oldPath ? "renamed" : "modified",
    additions: 1,
    deletions: 1,
    patch: "",
    binary: false,
  };
}

const renderer = file("src/renderer/app.tsx");
const renamed = file("src/renderer/theme.css", "styles/old-theme.css");
const sections = [
  { kind: "committed", files: [renderer, renamed] },
  { kind: "changes", files: [file("package.json")] },
];

describe("Changes sidebar path search", () => {
  it("preserves the full snapshot for an empty or whitespace query", () => {
    expect(filterChangeSections(sections, "")).toBe(sections);
    expect(filterChangeSections(sections, "  ")).toBe(sections);
  });

  it("matches parent folders case-insensitively and reuses unchanged sections", () => {
    const result = filterChangeSections(sections, "  SRC/Renderer  ");
    expect(result).toEqual([sections[0]]);
    expect(result[0]).toBe(sections[0]);
  });

  it("searches the rename source as well as the destination", () => {
    for (const query of ["old-theme", "renderer/theme"]) {
      const result = filterChangeSections(sections, query);
      expect(result).toEqual([{ kind: "committed", files: [renamed] }]);
      expect(result[0].files[0]).toBe(renamed);
    }
  });

  it("keeps a no-op match referentially stable", () => {
    expect(filterChangeSections(sections, ".")).toBe(sections);
  });

  it("does not mutate the scope snapshot when results are partial or empty", () => {
    const result = filterChangeSections(sections, "app.tsx");
    expect(result[0].files).toEqual([renderer]);
    expect(filterChangeSections(sections, "missing")).toEqual([]);
    expect(sections[0].files).toEqual([renderer, renamed]);
    expect(filterChangeSections(sections, "")).toBe(sections);
  });
});
