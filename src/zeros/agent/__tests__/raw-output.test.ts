// asDisplayString — the tool rawOutput fallback used by renderDetail. These
// guard the regression where Claude's raw tool_result (image blocks /
// empty-text content arrays) or Codex's protocol envelopes got JSON-dumped
// into the card. The helper is a pure module (no React) for testability.

import { describe, expect, it } from "vitest";

import { asDisplayString } from "../renderers/raw-output";

describe("asDisplayString", () => {
  it("passes a non-empty string through", () => {
    expect(asDisplayString("hello stdout")).toBe("hello stdout");
  });

  it("returns null for empty/nullish", () => {
    expect(asDisplayString("")).toBeNull();
    expect(asDisplayString(null)).toBeNull();
    expect(asDisplayString(undefined)).toBeNull();
  });

  it("stringifies numbers/booleans", () => {
    expect(asDisplayString(42)).toBe("42");
    expect(asDisplayString(true)).toBe("true");
  });

  it("extracts readable text from a content-block array (no JSON dump)", () => {
    const out = asDisplayString([
      { type: "text", text: "line 1" },
      { type: "text", text: "line 2" },
    ]);
    expect(out).toBe("line 1\nline 2");
  });

  it("returns null for an image-only content array (never dumps base64)", () => {
    const out = asDisplayString([
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "A".repeat(5000) },
      },
    ]);
    expect(out).toBeNull();
  });

  it("returns null for an empty-text content array", () => {
    expect(asDisplayString([{ type: "text", text: "" }])).toBeNull();
  });

  it("pretty-prints a small result object", () => {
    const out = asDisplayString({ exitCode: 0, stdout: "ok" });
    expect(out).toContain('"exitCode": 0');
    expect(out).toContain('"stdout": "ok"');
  });

  it("returns null for an object carrying a base64 blob", () => {
    expect(asDisplayString({ data: "B".repeat(500) })).toBeNull();
  });

  it("returns null for an oversized object envelope", () => {
    expect(asDisplayString({ junk: "x".repeat(30000) })).toBeNull();
  });

  it("returns null for empty object", () => {
    expect(asDisplayString({})).toBeNull();
  });
});
