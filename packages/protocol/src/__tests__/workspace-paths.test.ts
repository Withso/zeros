import { describe, expect, it } from "vitest";
import {
  WorkspacePathIndex,
  workspacePathScore,
  normalizeWorkspacePathQuery,
  compareWorkspaceEntries,
  type WorkspaceEntry,
} from "../workspace-paths";

describe("workspace path index", () => {
  const entries: WorkspaceEntry[] = [
    ...Array.from({ length: 2000 }, (_, i) => ({
      path: `node_modules/pkg-${i}/read-me.ts`,
      kind: "file" as const,
    })),
    { path: ".context/attachments", kind: "folder" },
    { path: ".context/attachments/🐈-rollout.jsonl", kind: "file" },
    { path: "a/README.md", kind: "file" },
    { path: "b/readme.md", kind: "file" },
    { path: "İ/README.md", kind: "file" },
    { path: "README.md", kind: "file" },
    { path: ".empty", kind: "folder" },
    { path: "foo/foo", kind: "folder" },
    { path: "[notes]+/back\\tick`.md", kind: "file" },
    { path: `${"parent/".repeat(70)}deep.ts`, kind: "file" },
  ];
  const index = new WorkspacePathIndex(entries);
  it.each([
    "",
    "r",
    "readme",
    "rdmts",
    "🐈rollout",
    "./.context/attachments/",
    "foo/",
    "[+\\`",
    "parent/deep",
    "parent/".repeat(50),
    "nomatch",
  ])("matches the full reference ranking for %j at every cap", (query) => {
    const q = normalizeWorkspacePathQuery(query);
    const reference = entries
      .flatMap((entry) => {
        const score = workspacePathScore(q, entry);
        return score === null ? [] : [{ entry, score }];
      })
      .sort(compareWorkspaceEntries)
      .map(({ entry }) => entry);
    for (const cap of [1, 8, 64, 20_000])
      expect(index.search(query, cap)).toEqual(reference.slice(0, cap));
  });

  it("reuses identical query results and does not lose out-of-window entries", () => {
    expect(index.search("READme", 8)).toBe(index.search("readme", 8));
    index.search("", 1);
    expect(index.search("🐈rollout", 1)[0].path).toBe(
      ".context/attachments/🐈-rollout.jsonl",
    );
  });

  it("preserves ranking across overlapping score tiers, punctuation, and Unicode", () => {
    let seed = 42;
    const random = (n: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % n;
    };
    const segments = [
      "src",
      "read-me",
      "README",
      "foo",
      "bar",
      "🐈",
      "İ",
      "白",
      "[a]+",
      "line\nbreak",
      "back\\tick`",
    ];
    const paths = new Map<string, WorkspaceEntry>();
    for (let i = 0; i < 800; i++) {
      const path = Array.from(
        { length: 1 + random(8) },
        () => segments[random(segments.length)],
      ).join("/");
      paths.set(path, { path, kind: random(3) === 0 ? "folder" : "file" });
    }
    const entries = Array.from(paths.values());
    const index = new WorkspacePathIndex(entries);
    const queries = [
      "",
      "/",
      "foo/",
      "fbr",
      "rdm",
      "🐈白",
      "[a]+",
      "\\`",
      "\n",
      "İ",
      "no-result",
      ...segments,
    ];
    for (const query of queries) {
      const reference = entries
        .flatMap((entry) => {
          const score = workspacePathScore(
            normalizeWorkspacePathQuery(query),
            entry,
          );
          return score === null ? [] : [{ entry, score }];
        })
        .sort(compareWorkspaceEntries)
        .map(({ entry }) => entry);
      for (const cap of [1, 3, 8, 64, 20_000]) {
        expect(index.search(query, cap), `${query} at ${cap}`).toEqual(
          reference.slice(0, cap),
        );
      }
    }
  });
});
