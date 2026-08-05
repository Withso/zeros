// Read-body parsing: accurate gutter start line + clean code, across the
// per-adapter shapes (Claude cat-n / offset, Codex shell range, whole-file).

import { describe, expect, it } from "vitest";

import { parseCommandStartLine, parseReadBody } from "../renderers/read-lines";

describe("parseCommandStartLine", () => {
  it("recovers the start line from a sed -n range", () => {
    expect(parseCommandStartLine("sed -n '1222,1280p' file.ts")).toBe(1222);
  });
  it("handles an unquoted sed range", () => {
    expect(parseCommandStartLine("sed -n 1222,1280p file")).toBe(1222);
  });
  it("handles a single-line sed", () => {
    expect(parseCommandStartLine("sed -n '40p' file")).toBe(40);
  });
  it("recovers tail -n +N", () => {
    expect(parseCommandStartLine("tail -n +1222 file")).toBe(1222);
    expect(parseCommandStartLine("tail -n+90 file")).toBe(90);
  });
  it("returns null for top-of-file reads (cat / head)", () => {
    expect(parseCommandStartLine("cat file")).toBeNull();
    expect(parseCommandStartLine("head -n 50 file")).toBeNull();
  });
});

describe("parseReadBody", () => {
  it("parses + strips Claude cat-n numbers (→)", () => {
    const r = parseReadBody("  1222→const a = 1\n  1223→const b = 2", {});
    expect(r.startLine).toBe(1222);
    expect(r.code).toBe("const a = 1\nconst b = 2");
  });

  it("parses + strips cat -n tab numbers", () => {
    const r = parseReadBody("   1\tfoo\n   2\tbar\n   3\tbaz", {});
    expect(r.startLine).toBe(1);
    expect(r.code).toBe("foo\nbar\nbaz");
  });

  it("uses Claude rawInput.offset when the text has no embedded numbers", () => {
    const r = parseReadBody("plain line\nanother line", { offset: 100 });
    expect(r.startLine).toBe(100);
    expect(r.code).toBe("plain line\nanother line");
  });

  it("recovers a Codex sed range from rawInput.command", () => {
    const r = parseReadBody("sliced\ncode", { command: "sed -n '500,560p' f.ts" });
    expect(r.startLine).toBe(500);
    expect(r.code).toBe("sliced\ncode");
  });

  it("falls back to 1 for whole-file reads (Cursor path-only / plain cat)", () => {
    expect(parseReadBody("a\nb\nc", { path: "f.ts" }).startLine).toBe(1);
    expect(parseReadBody("a\nb\nc", { command: "cat f.ts" }).startLine).toBe(1);
  });

  it("does NOT mis-strip a file that merely starts with a number", () => {
    // No → or tab separators → not treated as a numbered body.
    const text = "42 is the answer\nplain text here\nmore text";
    const r = parseReadBody(text, {});
    expect(r.startLine).toBe(1);
    expect(r.code).toBe(text);
  });

  it("drops a single trailing empty line from a final newline", () => {
    const r = parseReadBody("  10→x\n  11→y\n", {});
    expect(r.code).toBe("x\ny");
    expect(r.startLine).toBe(10);
  });
});
