import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const TOP_BAR = "apps/desktop/src/renderer/shell/top-bar.tsx";

function source(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

/** One switch case from prTabIcon, ending immediately before the next case. */
function prIconCase(src: string, kind: string, nextKind: string): string {
  const start = src.indexOf(`case "${kind}":`);
  const end = src.indexOf(`case "${nextKind}":`, start);
  if (start < 0 || end < 0) throw new Error(`${kind} PR icon case not found`);
  return src.slice(start, end);
}

describe("workspace tab PR icon", () => {
  it("uses the standard merge glyph without reflecting it", () => {
    const merged = prIconCase(source(TOP_BAR), "merged", "closed");

    expect(merged).toMatch(/<GitMerge(?:\s|>)/);
    expect(merged).not.toContain("<GitBranch");
    expect(merged).not.toMatch(/\b-?scale-x-/);
  });
});
