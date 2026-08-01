// Tests for the @-mention path model — the fuzzy ranking the file
// picker depends on. Pure functions, no DOM.

import { describe, it, expect } from "vitest";
import {
  buildPathMentions,
  collectMentions,
  deriveWorkspaceEntries,
  detectMentionTrigger,
  expandMentionsInText,
} from "../mentions";

const FILES = [
  "src/zeros/agent/agent-chat.tsx",
  "src/zeros/agent/mentions.ts",
  "src/engine/agents/registry.ts",
  "docs/how-auth-works.md",
  "README.md",
];

describe("deriveWorkspaceEntries", () => {
  it("emits every file plus each unique directory prefix", () => {
    const entries = deriveWorkspaceEntries(["src/zeros/agent/x.ts"]);
    const folders = entries
      .filter((e) => e.kind === "folder")
      .map((e) => e.path);
    const fileEntries = entries
      .filter((e) => e.kind === "file")
      .map((e) => e.path);
    expect(folders).toEqual(
      expect.arrayContaining(["src", "src/zeros", "src/zeros/agent"]),
    );
    expect(fileEntries).toEqual(["src/zeros/agent/x.ts"]);
  });

  it("dedupes shared directory prefixes", () => {
    const entries = deriveWorkspaceEntries([
      "a/b/one.ts",
      "a/b/two.ts",
      "a/c.ts",
    ]);
    const folders = entries
      .filter((e) => e.kind === "folder")
      .map((e) => e.path);
    // "a" and "a/b" appear once each despite multiple children.
    expect(folders.filter((f) => f === "a")).toHaveLength(1);
    expect(folders.filter((f) => f === "a/b")).toHaveLength(1);
  });
});

describe("buildPathMentions", () => {
  const entries = deriveWorkspaceEntries(FILES);

  it("ranks a basename match above a path-only match", () => {
    const out = buildPathMentions(entries, "mentions", 8);
    expect(out[0].query).toBe("src/zeros/agent/mentions.ts");
    expect(out[0].kind).toBe("file");
  });

  it("matches fuzzily across path segments (subsequence)", () => {
    // "agentchat" is a subsequence of "agent/agent-chat" — should match.
    const out = buildPathMentions(entries, "agentchat", 8);
    expect(out.some((m) => m.query === "src/zeros/agent/agent-chat.tsx")).toBe(
      true,
    );
  });

  it("wraps files in backticks and folders with a trailing slash", () => {
    const file = buildPathMentions(entries, "readme", 8)[0];
    expect(file.token).toBe("`README.md`");

    const folder = buildPathMentions(entries, "docs", 8).find(
      (m) => m.kind === "folder",
    );
    expect(folder?.token).toBe("`docs/`");
    expect(folder?.label).toBe("docs/");
  });

  it("returns no more than the limit, empty query included", () => {
    expect(buildPathMentions(entries, "", 3).length).toBeLessThanOrEqual(3);
  });

  it("leads the bare-@ view with files even in a folder-heavy tree", () => {
    // 10 distinct top-level folders, each holding one file. Under the old
    // folders-first ordering the empty-query early-out (first limit*3 = 9
    // entries) filled entirely with directory prefixes, so bare @ surfaced
    // NO files at all. Files-first ordering keeps files the primary result.
    const files = Array.from({ length: 10 }, (_, i) => `pkg${i}/index.ts`);
    const folderHeavy = deriveWorkspaceEntries(files);
    const bare = buildPathMentions(folderHeavy, "", 3);
    expect(bare).toHaveLength(3);
    expect(bare.every((m) => m.kind === "file")).toBe(true);
  });

  it("still matches a folder by name on a non-empty query", () => {
    // Files-first reorder must not regress folder discoverability: `@docs`
    // should still surface the docs/ directory prefix.
    const folder = buildPathMentions(entries, "docs", 8).find(
      (m) => m.kind === "folder",
    );
    expect(folder?.query).toBe("docs");
  });

  it("returns nothing for a query that matches no path", () => {
    expect(buildPathMentions(entries, "zzzznomatch", 8)).toEqual([]);
  });
});

describe("detectMentionTrigger", () => {
  it("captures a path query that contains slashes", () => {
    const text = "look at @src/zeros";
    const t = detectMentionTrigger(text, text.length);
    expect(t).not.toBeNull();
    expect(t?.query).toBe("src/zeros");
  });

  it("does not trigger mid-word (email-style @)", () => {
    const text = "ping me@example";
    expect(detectMentionTrigger(text, text.length)).toBeNull();
  });
});

describe("selection mentions", () => {
  const designSelection = {
    tag: "h1",
    selector: '[data-oid="hero-heading"]',
    componentName: "Hero heading",
    frame: "home.html",
    oid: "hero-heading",
  };

  it("describes an element-level design selection in the picker", () => {
    expect(collectMentions(designSelection)).toEqual([
      expect.objectContaining({
        token: "@selection",
        hint: "h1 (Hero heading)",
      }),
    ]);
  });

  it("expands @selection with the immutable frame and oid identity", () => {
    expect(expandMentionsInText("Tighten @selection", designSelection)).toBe(
      'Tighten the currently-selected design element (<h1>, frame home.html, data-oid "hero-heading")',
    );
  });
});
