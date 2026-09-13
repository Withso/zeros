import { describe, expect, it } from "vitest";
import { designGitignoreSource } from "../gitignore";

describe("managed Design ignore rules", () => {
  it("preserves mixed line endings outside its own block on repeated saves", () => {
    const original = "# Existing rules\r\nbuild/\n.zeros/\r\n";
    const first = designGitignoreSource(original);
    expect(first.startsWith(original)).toBe(true);
    expect(designGitignoreSource(first)).toBe(first);
    const later = "# Later user rules\ncache/\r\n";
    const repaired = designGitignoreSource(first + later);
    expect(repaired.startsWith(original + later)).toBe(true);
    expect(designGitignoreSource(repaired)).toBe(repaired);
  });
});
