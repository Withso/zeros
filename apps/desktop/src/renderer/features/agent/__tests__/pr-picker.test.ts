// #-PR picker trigger + filter (pure logic).

import { describe, expect, it } from "vitest";

import { detectHashTrigger, filterPrs, type PrPickerItem } from "../pr-picker";

describe("detectHashTrigger", () => {
  it("fires for '#' at the start", () => {
    expect(detectHashTrigger("#", 1)).toEqual({ start: 0, end: 1, query: "" });
    expect(detectHashTrigger("#12", 3)).toEqual({ start: 0, end: 3, query: "12" });
  });

  it("fires for '#' at a word boundary mid-text", () => {
    const t = detectHashTrigger("see #45", 7);
    expect(t).toEqual({ start: 4, end: 7, query: "45" });
  });

  it("does NOT fire when '#' is glued to a preceding word (e.g. a hex color)", () => {
    // The real-world trigger is a hex color in prose (`color:#fff`). Use a
    // non-hex token here so check:ui's hex-literal lint stays green — the
    // branch under test is "'#' preceded by a non-space char", exercised
    // identically by either input.
    expect(detectHashTrigger("token#pr", 8)).toBeNull();
  });

  it("does NOT fire once the query contains whitespace", () => {
    expect(detectHashTrigger("#12 more", 8)).toBeNull();
  });

  it("returns null with no '#' before the caret", () => {
    expect(detectHashTrigger("hello world", 5)).toBeNull();
  });
});

describe("filterPrs", () => {
  const prs: PrPickerItem[] = [
    { number: 12, title: "Fix the composer" },
    { number: 345, title: "Add dark mode" },
    { number: 7, title: "composer paste support" },
  ];

  it("returns all (capped) for an empty query", () => {
    expect(filterPrs(prs, "").length).toBe(3);
  });

  it("matches by PR number prefix", () => {
    expect(filterPrs(prs, "3").map((p) => p.number)).toEqual([345]);
  });

  it("matches by title substring (case-insensitive)", () => {
    expect(filterPrs(prs, "composer").map((p) => p.number)).toEqual([12, 7]);
  });
});
