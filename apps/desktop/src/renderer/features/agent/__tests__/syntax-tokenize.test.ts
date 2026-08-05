// tokenizeSync is the contract that lets the file editor paint its first frame
// already in the code theme (see code-editor/shiki-highlight.ts). Exercised
// against the real bundled shiki so the "is this grammar/theme loaded yet"
// alias handling is verified, not assumed.

import { describe, it, expect, beforeAll } from "vitest";

import {
  SYNC_TOKENIZE_MAX,
  nthNewlineIndex,
  prewarmSyntax,
  tokenizeSync,
  highlightToTokens,
} from "../renderers/syntax";

const THEME = "github-dark-default";
const CODE = `const greeting: string = "hi";\nexport default greeting;\n`;

describe("nthNewlineIndex", () => {
  it("finds the n-th newline and reports too-few", () => {
    expect(nthNewlineIndex("a\nb\nc", 1)).toBe(1);
    expect(nthNewlineIndex("a\nb\nc", 2)).toBe(3);
    expect(nthNewlineIndex("a\nb\nc", 3)).toBe(-1);
    expect(nthNewlineIndex("no newlines", 1)).toBe(-1);
  });
});

describe("tokenizeSync", () => {
  beforeAll(async () => {
    await prewarmSyntax("typescript", THEME);
  });

  it("returns null for no language and for plain text", () => {
    expect(tokenizeSync(CODE, null, THEME)).toBeNull();
    expect(tokenizeSync(CODE, "text", THEME)).toBeNull();
  });

  it("tokenizes a warm (language, theme) pair on the spot", () => {
    const res = tokenizeSync(CODE, "typescript", THEME);
    expect(res).not.toBeNull();
    expect(res!.partial).toBeUndefined();
    expect(res!.fg).toBeTruthy();
    // Offsets are absolute UTF-16 positions — that is what makes them usable as
    // CodeMirror ranges without any remapping.
    const flat = res!.tokens.flat();
    expect(flat.length).toBeGreaterThan(3);
    for (const tok of flat) {
      expect(CODE.slice(tok.offset, tok.offset + tok.content.length)).toBe(
        tok.content,
      );
    }
  });

  it("serves a repeat request from the cache (same object)", () => {
    const first = tokenizeSync(CODE, "typescript", THEME);
    expect(tokenizeSync(CODE, "typescript", THEME)).toBe(first);
  });

  it("resolves aliases the highlighter loaded under another name", () => {
    // The shared highlighter pre-loads "ts"; shiki registers it as
    // "typescript" + aliases, so both ids must answer synchronously.
    expect(tokenizeSync(CODE, "ts", THEME)).not.toBeNull();
  });

  it("returns null for a language that is not loaded", () => {
    expect(tokenizeSync(CODE, "not-a-real-language", THEME)).toBeNull();
  });

  it("returns null for a theme that is not loaded", () => {
    expect(tokenizeSync(CODE, "typescript", "nord")).toBeNull();
  });

  it("declines an oversized input unless head lines are requested", () => {
    const big = CODE.repeat(4_000);
    expect(big.length).toBeGreaterThan(SYNC_TOKENIZE_MAX);
    expect(tokenizeSync(big, "typescript", THEME)).toBeNull();
    const head = tokenizeSync(big, "typescript", THEME, { headLines: 20 });
    expect(head?.partial).toBe(true);
    expect(head!.tokens.length).toBe(20);
  });

  it("declines an oversized single line (minified) even with head lines", () => {
    const minified = `const a=${"1+".repeat(40_000)}1;`;
    expect(minified.length).toBeGreaterThan(SYNC_TOKENIZE_MAX);
    expect(
      tokenizeSync(minified, "typescript", THEME, { headLines: 20 }),
    ).toBeNull();
  });
});

describe("highlightToTokens", () => {
  it("loads a grammar on demand and never returns a partial", async () => {
    // "ini" is outside the pre-loaded set, so this exercises the on-demand path.
    const res = await highlightToTokens("[a]\nb = 1\n", "ini", THEME);
    expect(res).not.toBeNull();
    expect(res!.partial).toBeUndefined();
    // Now warm: the same request answers synchronously (this is what makes a
    // re-open of the same file instant).
    expect(tokenizeSync("[a]\nb = 1\n", "ini", THEME)).toBe(res);
  });

  it("returns null for a grammar shiki does not have", async () => {
    expect(
      await highlightToTokens("x", "not-a-real-language", THEME),
    ).toBeNull();
  });
});
