// asDisplayString — the tool rawOutput fallback used by renderDetail. These
// guard the regression where Claude's raw tool_result (image blocks /
// empty-text content arrays) or Codex's protocol envelopes got JSON-dumped
// into the card. The helper is a pure module (no React) for testability.

import { describe, expect, it } from "vitest";

import { asDisplayString } from "../renderers/raw-output";

describe("asDisplayString", () => {
  it("bounds traversal of wide repeated structures before serialization", () => {
    let reads = 0;
    const branch = (depth: number): object => Object.fromEntries(Array.from({ length: 8 }, (_, index) => [String(index), depth ? branch(depth - 1) : "leaf"]));
    const visit = (value: object): object => new Proxy(value, { get(target, property, receiver) {
      reads += 1;
      const child = Reflect.get(target, property, receiver);
      return child && typeof child === "object" ? visit(child) : child;
    } });
    expect(asDisplayString(visit(branch(3)))).toContain("leaf");
    expect(reads).toBeLessThan(2_000);
  });
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

  it("retains a bounded preview of oversized output instead of hiding it", () => {
    const text = asDisplayString({ output: "x".repeat(30000) });
    expect(text).toContain("xxx");
    expect(text?.length).toBeLessThanOrEqual(20_001);
    expect(text).toMatch(/…$/);
  });

  it("keeps readable fields next to binary and structured result arrays", () => {
    expect(asDisplayString({ text: "Screenshot saved", data: "B".repeat(500) })).toContain("Screenshot saved");
    expect(asDisplayString([{ title: "Example", url: "https://example.com" }])).toContain("https://example.com");
  });

  it("returns null for empty object", () => {
    expect(asDisplayString({})).toBeNull();
  });
});
