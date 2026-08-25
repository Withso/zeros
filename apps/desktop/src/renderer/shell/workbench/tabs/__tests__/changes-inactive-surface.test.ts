import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

describe("inactive retained Changes surface", () => {
  it("gates its Git subscription and background model work on active", () => {
    const surface = readFileSync(
      fileURLToPath(new URL("../changes-surface.tsx", import.meta.url)),
      "utf8",
    );
    const model = readFileSync(
      fileURLToPath(new URL("../changes-tab.tsx", import.meta.url)),
      "utf8",
    );

    expect(surface).toContain("useGitRefreshKey(cwd, changesTarget, active)");
    expect(surface).toMatch(/useChangesModel\(\{[\s\S]{0,180}\bactive,/);
    expect(model).toMatch(
      /export function useChangesModel\(\{[\s\S]{0,180}\bactive,/,
    );
    expect(
      model.match(/if \(!active\) return;/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(3);
  });

  it("keeps the retained Review surface from pulling a local diff while hidden", () => {
    const surface = readFileSync(
      fileURLToPath(new URL("../review-surface.tsx", import.meta.url)),
      "utf8",
    );
    const view = readFileSync(
      fileURLToPath(new URL("../review-tab.tsx", import.meta.url)),
      "utf8",
    );

    expect(surface).toMatch(
      /useGitRefreshKey\(\s*workspace\?\.path,\s*changesTarget,\s*active,?\s*\)/,
    );
    expect(view).toMatch(
      /\/\/ ── local PR diff[\s\S]{0,1800}useEffect\(\(\) => \{\s*if \(!active\) return;/,
    );
  });

  it("does not subscribe hidden Files or Context surfaces to Git refreshes", () => {
    for (const file of ["../files-tab.tsx", "../context-surface.tsx"]) {
      const source = readFileSync(
        fileURLToPath(new URL(file, import.meta.url)),
        "utf8",
      );
      expect(source).toMatch(
        /useGitRefreshKey\(\s*cwd,\s*workspaceId,\s*active,?\s*\)/,
      );
    }

    const files = readFileSync(
      fileURLToPath(new URL("../files-tab.tsx", import.meta.url)),
      "utf8",
    );
    expect(files).toMatch(/<WorkspaceFileTree[\s\S]{0,180}\bactive=\{active\}/);
    expect(files).toMatch(
      /<FilesSearchSidebar[\s\S]{0,180}\bactive=\{active\}/,
    );
  });
});
