import { describe, it, expect } from "vitest";
import { trimTrailingSegments } from "../renderers/trim-trailing-segments";
import type { MessageContentSegment } from "../use-agent-session";

const text = (t: string): MessageContentSegment => ({ type: "text", text: t });
const mention = (label: string): MessageContentSegment => ({
  type: "mention",
  label,
  path: `/${label}`,
  kind: "file",
});

describe("trimTrailingSegments", () => {
  it("trims trailing newlines from a single text segment (the screenshot bug)", () => {
    expect(trimTrailingSegments([text("jsdfnsd\n\n\n\n")])).toEqual([
      text("jsdfnsd"),
    ]);
  });

  it("trims trailing spaces and tabs", () => {
    expect(trimTrailingSegments([text("hello \t  ")])).toEqual([text("hello")]);
  });

  it("preserves interior whitespace — only the end is trimmed", () => {
    expect(trimTrailingSegments([text("a\n\nb\n\n")])).toEqual([text("a\n\nb")]);
  });

  it("preserves leading whitespace", () => {
    expect(trimTrailingSegments([text("  indented  ")])).toEqual([
      text("  indented"),
    ]);
  });

  it("returns the SAME reference when there is nothing to trim", () => {
    const segs = [text("clean")];
    expect(trimTrailingSegments(segs)).toBe(segs);
  });

  it("does NOT trim whitespace that sits before a trailing pill (that's the middle)", () => {
    const segs = [text("hi"), text("\n\n"), mention("file.ts")];
    // last segment is a pill → tail is real content, nothing trimmed
    expect(trimTrailingSegments(segs)).toBe(segs);
  });

  it("trims a trailing text segment that follows a pill", () => {
    expect(
      trimTrailingSegments([text("see "), mention("file.ts"), text("\n\n")]),
    ).toEqual([text("see "), mention("file.ts")]);
  });

  it("drops fully-whitespace trailing text but keeps the pill before it", () => {
    expect(trimTrailingSegments([mention("file.ts"), text("   ")])).toEqual([
      mention("file.ts"),
    ]);
  });

  it("walks back across several trailing whitespace text segments", () => {
    expect(
      trimTrailingSegments([text("word"), text("  "), text("\n")]),
    ).toEqual([text("word")]);
  });

  it("collapses an all-whitespace message to empty", () => {
    expect(trimTrailingSegments([text("   \n\n")])).toEqual([]);
  });

  it("leaves a lone pill untouched", () => {
    const segs = [mention("file.ts")];
    expect(trimTrailingSegments(segs)).toBe(segs);
  });

  it("handles the empty array", () => {
    const segs: MessageContentSegment[] = [];
    expect(trimTrailingSegments(segs)).toBe(segs);
  });
});
