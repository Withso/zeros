import { describe, expect, it } from "vitest";

import { markdownLinkTarget } from "../markdown-links";

// A link in a previewed Markdown file opens the file it names, resolved the
// way GitHub resolves repository links. This is also the boundary: nothing
// outside the workspace, and no URL, anchor or folder, becomes a file.
describe("markdownLinkTarget", () => {
  it("resolves from the folder of the file that holds the link", () => {
    const from = "docs/README.md";
    expect(markdownLinkTarget("guide.md", from)).toBe("docs/guide.md");
    expect(markdownLinkTarget("./guide.md", from)).toBe("docs/guide.md");
    expect(markdownLinkTarget("sub/notes.md", from)).toBe("docs/sub/notes.md");
    expect(markdownLinkTarget("../RULES.md", from)).toBe("RULES.md");
    expect(markdownLinkTarget("sub/../guide.md", from)).toBe("docs/guide.md");
    expect(markdownLinkTarget("README.md", "README.md")).toBe("README.md");
    expect(markdownLinkTarget("LICENSE", "README.md")).toBe("LICENSE");
  });

  it("resolves a leading slash from the workspace root", () => {
    expect(markdownLinkTarget("/apps/web/main.ts", "docs/README.md")).toBe("apps/web/main.ts");
  });

  it("drops anchors and queries and decodes the path", () => {
    const from = "docs/README.md";
    expect(markdownLinkTarget("ci.md#labels", from)).toBe("docs/ci.md");
    expect(markdownLinkTarget("ci.md?plain=1", from)).toBe("docs/ci.md");
    expect(markdownLinkTarget("My%20Notes.md", from)).toBe("docs/My Notes.md");
    expect(markdownLinkTarget("  guide.md  ", from)).toBe("docs/guide.md");
  });

  it("keeps URLs, anchors, folders and paths outside the workspace as links", () => {
    const from = "docs/README.md";
    for (const href of [
      "",
      "#usage",
      "?plain=1",
      "https://example.com/guide.md",
      "mailto:team@example.com",
      "file:///etc/passwd",
      "zeros-local://chat/1",
      "C:\\notes.md",
      "//cdn.example.com/a.md",
      "../../outside.md",
      "/../outside.md",
      "sub/",
      ".",
      "..",
      "../",
      "a\\b.md",
      "a%00.md",
      "%E0%A4%A.md",
    ]) {
      expect(markdownLinkTarget(href, from), href).toBeNull();
    }
    expect(markdownLinkTarget("../x.md", "README.md")).toBeNull();
  });
});
