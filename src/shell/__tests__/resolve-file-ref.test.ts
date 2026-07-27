import { describe, expect, it } from "vitest";

import { pickFileMatch } from "../resolve-file-ref";

// pickFileMatch turns a loose agent reference ("AskAIChat.tsx") into a real
// workspace path so a bare/partial mention still opens the right file in row 1.
describe("pickFileMatch", () => {
  const FILES = [
    "package.json",
    "src/styles/variables.css",
    "src/zeros/agent/AskAIChat.tsx",
    "src/zeros/MyAskAIChat.tsx",
    "src/a/util.ts",
    "src/b/c/util.ts",
  ];

  it("returns an exact full path verbatim", () => {
    expect(pickFileMatch(FILES, "src/styles/variables.css")).toBe(
      "src/styles/variables.css",
    );
    expect(pickFileMatch(FILES, "package.json")).toBe("package.json");
  });

  it("resolves a bare basename to its nested file", () => {
    expect(pickFileMatch(FILES, "AskAIChat.tsx")).toBe(
      "src/zeros/agent/AskAIChat.tsx",
    );
    expect(pickFileMatch(FILES, "variables.css")).toBe(
      "src/styles/variables.css",
    );
  });

  it("resolves a trailing sub-path", () => {
    expect(pickFileMatch(FILES, "agent/AskAIChat.tsx")).toBe(
      "src/zeros/agent/AskAIChat.tsx",
    );
  });

  it("anchors the basename at a path boundary (no substring false-positives)", () => {
    // "AskAIChat.tsx" must NOT match "MyAskAIChat.tsx".
    expect(pickFileMatch(["src/zeros/MyAskAIChat.tsx"], "AskAIChat.tsx")).toBe(
      null,
    );
  });

  it("breaks ties by shortest path, then lexicographically", () => {
    // util.ts lives at src/a/util.ts (2 dirs) and src/b/c/util.ts (3 dirs).
    expect(pickFileMatch(FILES, "util.ts")).toBe("src/a/util.ts");
    expect(pickFileMatch(["z/x.ts", "a/x.ts"], "x.ts")).toBe("a/x.ts");
  });

  it("returns null when nothing matches or the ref is empty", () => {
    expect(pickFileMatch(FILES, "does-not-exist.ts")).toBe(null);
    expect(pickFileMatch(FILES, "")).toBe(null);
    expect(pickFileMatch([], "anything.ts")).toBe(null);
  });
});
