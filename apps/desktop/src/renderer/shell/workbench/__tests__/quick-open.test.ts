import { describe, expect, it } from "vitest";

import {
  searchRecentBrowsers,
  searchWorkspaceFiles,
} from "../quick-open";

describe("searchWorkspaceFiles", () => {
  const files = [
    "src/components/Button.tsx",
    "src/components/ComponentSnapshots.tsx",
    "src/button-styles.css",
    "docs/button.md",
    "packages/server/src/index.ts",
    "packages/client/src/index.ts",
    "src/café/menu.ts",
  ];

  it("ranks an exact basename before prefix and path-only matches", () => {
    const result = searchWorkspaceFiles(files, "button.tsx");
    expect(result[0].path).toBe("src/components/Button.tsx");
  });

  it("requires every search term and supports compact fuzzy subsequences", () => {
    expect(searchWorkspaceFiles(files, "cmp snap")[0].path).toBe(
      "src/components/ComponentSnapshots.tsx",
    );
    expect(
      searchWorkspaceFiles(files, "server index").map((item) => item.path),
    ).toEqual(["packages/server/src/index.ts"]);
  });

  it("is case/diacritic insensitive and applies a stable result limit", () => {
    expect(searchWorkspaceFiles(files, "CAFE")[0].path).toBe(
      "src/café/menu.ts",
    );
    expect(searchWorkspaceFiles(files, "index", 1)).toHaveLength(1);
    expect(searchWorkspaceFiles(files, "index", 0)).toEqual([]);
  });
});

describe("searchRecentBrowsers", () => {
  const recent = [
    {
      url: "https://example.com/reference",
      title: "API Reference",
      visitedAt: 20,
    },
    {
      url: "https://developer.mozilla.org/en-US/docs/Web/API",
      title: "Web APIs",
      visitedAt: 30,
    },
    {
      url: "https://older.example.com/reference",
      title: "API Reference",
      visitedAt: 10,
    },
  ];

  it("searches both page titles and URLs", () => {
    expect(searchRecentBrowsers(recent, "web api")[0].title).toBe("Web APIs");
    expect(searchRecentBrowsers(recent, "mozilla")[0].url).toContain(
      "developer.mozilla.org",
    );
  });

  it("uses recency to break equal-score ties and respects the limit", () => {
    const result = searchRecentBrowsers(recent, "api reference", 1);
    expect(result).toHaveLength(1);
    expect(result[0].visitedAt).toBe(20);
  });
});
