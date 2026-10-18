import { describe, expect, it } from "vitest";
import {
  completeCssPrefix,
  designAgentStylesheetPreviewText,
} from "../agent-draft-css";
import {
  applyDesignAgentPatch,
  designAgentDraftKind,
  designAgentStructuredEdits,
} from "../agent-drafts";

describe("In-flight Design stylesheet text", () => {
  it("keeps only complete top-level rules and statements", () => {
    expect(completeCssPrefix("@layer reset;\n:root { --a: 1px; }\n.card { padding: 8")).toBe(
      "@layer reset;\n:root { --a: 1px; }",
    );
    // Nested blocks close only at depth zero.
    expect(completeCssPrefix("@media (width > 1px) { .a { color: red; } .b {")).toBe("");
    expect(completeCssPrefix("@media (width > 1px) { .a { color: red; } }")).toBe(
      "@media (width > 1px) { .a { color: red; } }",
    );
    // Braces inside strings and comments never close a rule.
    expect(completeCssPrefix('.a { content: "}"; } .b { content: "{')).toBe('.a { content: "}"; }');
    expect(completeCssPrefix(".a { color: red; } /* } .b {} */ .c {}")).toBe(
      ".a { color: red; } /* } .b {} */ .c {}",
    );
    expect(completeCssPrefix(".a { color: red; } /* unfinished }")).toBe(".a { color: red; }");
    expect(completeCssPrefix("")).toBe("");
  });

  it("follows the saved rules while streaming, then shows the finished file alone", () => {
    const saved = ":root { --accent: red; }";
    expect(designAgentStylesheetPreviewText(saved, ":root { --accent: blue; } .x {", false)).toBe(
      `${saved}\n:root { --accent: blue; }`,
    );
    expect(designAgentStylesheetPreviewText(null, ".x { color: red; } .y", false)).toBe(".x { color: red; }");
    expect(designAgentStylesheetPreviewText(saved, ".only {}", true)).toBe(".only {}");
  });
});

describe("Whole provider changes", () => {
  it("reads Codex patches, diff content and complete input per file", () => {
    expect(
      designAgentStructuredEdits({
        sessionUpdate: "tool_call",
        rawInput: {
          changes: [
            { path: "/d/a.html", kind: { type: "add" }, diff: "<main/>" },
            { path: "/d/b.html", kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-a\n+b" },
            { path: "/d/c.html", kind: { type: "delete" }, diff: "<main/>" },
            { path: "/d/d.html", kind: { type: "update", move_path: "/d/e.html" }, diff: "" },
          ],
        },
        content: [{ type: "diff", path: "/d/f.css", oldText: "", newText: ".f{}" }, { type: "content" }],
        locations: [{ path: "/d/c.html" }, { path: "/d/g.html" }],
      }),
    ).toEqual([
      { path: "/d/a.html", operation: "write", content: "<main/>" },
      { path: "/d/b.html", operation: "edit", patch: "@@ -1 +1 @@\n-a\n+b" },
      { path: "/d/f.css", operation: "write", content: ".f{}" },
      // A deletion or move is never drafted, even when also named elsewhere.
      { path: "/d/g.html", operation: "edit" },
    ]);
    expect(
      designAgentStructuredEdits({ sessionUpdate: "tool_call", rawInput: { file_path: "/d/a.html", old_string: "x", new_string: "y" } }),
    ).toEqual([{ path: "/d/a.html", operation: "edit", edit: { file_path: "/d/a.html", old_string: "x", new_string: "y" } }]);
    expect(designAgentStructuredEdits({ sessionUpdate: "tool_call", rawInput: { path: "/d/a.html" } })).toEqual([
      { path: "/d/a.html", operation: "edit" },
    ]);
  });

  it("applies unified diff hunks only while they still match the saved text", () => {
    expect(applyDesignAgentPatch("one\nold\nthree\n", "@@ -1,3 +1,3 @@\n one\n-old\n+new\n three\n")).toBe(
      "one\nnew\nthree\n",
    );
    expect(applyDesignAgentPatch("one\n", "@@ -1 +1 @@\n-two\n+three\n")).toBeNull();
    expect(applyDesignAgentPatch("one\n", "not a patch @@")).toBeNull();
  });

  it("classifies drafted files by what they preview as", () => {
    expect(designAgentDraftKind("page-1/home.html")).toBe("frame");
    expect(designAgentDraftKind("meta/canvas.json")).toBe("canvas");
    expect(designAgentDraftKind("tokens.css")).toBe("stylesheet");
    expect(designAgentDraftKind("page-1/page.css")).toBe("stylesheet");
    expect(designAgentDraftKind("rules.md")).toBe("other");
  });
});
