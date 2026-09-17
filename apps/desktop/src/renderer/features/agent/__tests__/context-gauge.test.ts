import { describe, expect, it } from "vitest";
import { contextGaugeData } from "../context-usage";

describe("context gauge categories", () => {
  it("uses native free space once, keeps buffer separate, and hides deferred schemas", () => {
    const data = contextGaugeData({
      size: 200,
      used: 80,
      categories: [
        { name: "Messages", tokens: 60, kind: "used" },
        { name: "Available room", tokens: 100, kind: "free" },
        { name: "System prompt", tokens: 20, kind: "used" },
        { name: "Autocompact buffer", tokens: 20, kind: "buffer" },
        { name: "On-demand tools", tokens: 500, kind: "deferred" },
        { name: "Another free label", tokens: 100, kind: "free" },
      ],
    });
    expect(data?.fraction).toBe(0.4);
    expect(data?.rows).toEqual([
      { name: "Free space", tokens: 100, kind: "free" },
      { name: "Messages", tokens: 60, kind: "used" },
      { name: "System prompt", tokens: 20, kind: "used" },
      { name: "Autocompact buffer", tokens: 20, kind: "buffer" },
    ]);
  });

  it("does not rewrite authoritative totals to match estimated category counts", () => {
    const data = contextGaugeData({
      size: 200,
      used: 80,
      categories: [
        { name: "Messages", tokens: 75, kind: "used" },
        { name: "Available", tokens: 105, kind: "free" },
        { name: "Buffer", tokens: 20, kind: "buffer" },
      ],
    });
    expect(data).toMatchObject({ size: 200, used: 80, fraction: 0.4 });
    expect(data?.rows[0].tokens).toBe(105);
  });

  it("subtracts reserve only when computing missing free space", () => {
    const categories = [
      { name: "Reserve", tokens: 20, kind: "buffer" as const },
    ];
    expect(contextGaugeData({ size: 200, used: 80, categories })?.rows).toEqual(
      [
        { name: "Free space", tokens: 100, kind: "free" },
        { name: "Used", tokens: 80, kind: "used" },
        { name: "Reserve", tokens: 20, kind: "buffer" },
      ],
    );
    expect(
      contextGaugeData({
        size: 200,
        used: 80,
        categories: [
          ...categories,
          { name: "Available", tokens: 0, kind: "free" },
        ],
      })?.rows[0].tokens,
    ).toBe(0);
  });

  it("supports legacy snapshots and preserves native kind over a misleading name", () => {
    expect(
      contextGaugeData({
        size: 100,
        used: 30,
        categories: [
          { name: "Messages", tokens: 30 },
          { name: "MCP tools (deferred)", tokens: 500 },
          { name: "Compact buffer", tokens: 10 },
          { name: "Free space", tokens: 60 },
        ],
      })?.rows,
    ).toEqual([
      { name: "Free space", tokens: 60, kind: "free" },
      { name: "Messages", tokens: 30, kind: "used" },
      { name: "Compact buffer", tokens: 10, kind: "buffer" },
    ]);
    expect(
      contextGaugeData({
        size: 100,
        used: 30,
        categories: [{ name: "Tools (deferred)", tokens: 30, kind: "used" }],
      })?.rows[1],
    ).toEqual({ name: "Tools (deferred)", tokens: 30, kind: "used" });
  });

  it("retains Used/Free for providers without categories and after clearing context", () => {
    expect(contextGaugeData({ size: 100, used: 30 })?.rows).toEqual([
      { name: "Free space", tokens: 70, kind: "free" },
      { name: "Used", tokens: 30, kind: "used" },
    ]);
    expect(
      contextGaugeData({ size: 100, used: 0, categories: [] })?.rows,
    ).toEqual([
      { name: "Free space", tokens: 100, kind: "free" },
      { name: "Used", tokens: 0, kind: "used" },
    ]);
  });

  it("bounds free space and the ring without clamping the over-limit headline", () => {
    const data = contextGaugeData({
      size: 100,
      used: 120,
      categories: [
        { name: "Available", tokens: 50, kind: "free" },
        { name: "Messages", tokens: 120, kind: "used" },
      ],
    });
    expect(data).toMatchObject({ used: 120, size: 100, fraction: 1 });
    expect(data?.rows[0].tokens).toBe(0);
    expect(
      contextGaugeData({
        size: 100,
        used: 80,
        categories: [{ name: "Reserve", tokens: 200, kind: "buffer" }],
      })?.rows[0].tokens,
    ).toBe(0);
  });

  it.each([
    null,
    undefined,
    { size: 0, used: 0 },
    { size: Infinity, used: 20 },
    { size: 100, used: NaN },
    { size: 100, used: -1 },
    { size: 100, used: Infinity },
  ])("does not render invalid context totals: %j", (usage) => {
    expect(contextGaugeData(usage)).toBeNull();
  });

  it("ignores malformed rows without changing totals or mutating the source", () => {
    const categories = Object.freeze([
      { name: "Zero", tokens: 0, kind: "used" as const },
      { name: "Infinite", tokens: Infinity, kind: "buffer" as const },
      { name: "Negative", tokens: -1, kind: "used" as const },
      { name: " ", tokens: 20, kind: "used" as const },
      { name: "Messages", tokens: 20, kind: "used" as const },
    ]);
    expect(
      contextGaugeData({ size: 100, used: 20, categories: [...categories] })
        ?.rows,
    ).toEqual([
      { name: "Free space", tokens: 80, kind: "free" },
      { name: "Messages", tokens: 20, kind: "used" },
    ]);
  });
});
