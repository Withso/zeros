import { describe, expect, it } from "vitest";

// Imported from the pure module (not ../markdown) so the suite runs in the
// node test env — markdown.ts pulls in DOMPurify, which needs a DOM. The
// rendering/split path is exercised in the app; this locks the detection +
// safety boundary, the part most likely to regress.
import { fileRefPath } from "../markdown-file-path";

// fileRefPath decides which inline-code spans (and which `[name](href)` links)
// become clickable "open in row 1" references — and is the safety boundary:
// absolute paths, drive letters and `..` traversal must never resolve.
describe("fileRefPath", () => {
  it("accepts workspace-relative file paths", () => {
    for (const p of [
      "src/styles/variables.css",
      "ColorNodeCard.tsx",
      "ColorCanvas.tsx",
      "notes.md",
      "electron/ipc/commands/files.ts",
      "files.test.ts",
      "package.json",
      "railway.json",
    ]) {
      expect(fileRefPath(p)).toBe(p);
    }
  });

  it("strips a :line[:col] suffix and a leading ./", () => {
    expect(fileRefPath("index.ts:1669")).toBe("index.ts");
    expect(fileRefPath("src/app.ts:12:4")).toBe("src/app.ts");
    expect(fileRefPath("./README.md")).toBe("README.md");
  });

  it("accepts absolute POSIX paths and file:// URLs (gated at open time)", () => {
    // Agents reference files absolutely too — these must read as file chips,
    // NOT external links that navigate the app to localhost/<abs-path>. The
    // workspace boundary is enforced when the file is opened, not here.
    expect(fileRefPath("/Users/dev/proj/src/app.ts")).toBe(
      "/Users/dev/proj/src/app.ts",
    );
    expect(fileRefPath("/Users/dev/ws/test.md:42")).toBe("/Users/dev/ws/test.md");
    expect(fileRefPath("file:///Users/dev/ws/test.md")).toBe(
      "/Users/dev/ws/test.md",
    );
  });

  it("leaves prose tags / identifiers / package names plain", () => {
    for (const t of [
      "needsAuth",
      "ready",
      "error",
      "mcp_auth",
      "js_reset",
      "js_add_node_module_dir",
      'serverStatus: "needsAuth"',
      "@hono/node-server",
      "@package.json", // a mention, not a path
      "e.g.",
      "a.b", // unknown extension
    ]) {
      expect(fileRefPath(t)).toBeNull();
    }
  });

  it("rejects traversal, non-file strings and URLs", () => {
    for (const t of [
      "/etc/passwd", // absolute, but no recognised extension
      "../secret.ts",
      "../../x.ts",
      "/a/b/../c.ts", // traversal inside an absolute path
      "C:\\windows\\system.ts",
      "https://example.com",
      "https://example.com/file.json", // a URL, even with an extension
      "",
      "   ",
    ]) {
      expect(fileRefPath(t)).toBeNull();
    }
  });
});
