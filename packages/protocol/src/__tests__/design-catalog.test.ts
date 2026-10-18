import { describe, expect, it } from "vitest";
import {
  designCatalogBatchSchema,
  designCatalogReadSchema,
  designCatalogReplySchema,
} from "../design-catalog";

const batch = {
  kind: "design-catalog",
  version: 1,
  status: "ready",
  owner: {
    workspaceId: "local",
    directoryId: "design_test",
    organizationId: null,
    placement: "local",
  },
  binding: "b".repeat(64),
  revision: "a".repeat(64),
  intent: 1,
  pages: [{ id: "p", title: "Page", folder: "", count: 1 }],
  total: 1,
  offset: 0,
  frames: [
    {
      id: "home",
      source: "home.html",
      pageId: "p",
      title: "Home",
      kind: "html",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      z: 0,
      order: 0,
      preparation: "unprepared",
    },
  ],
  coverage: "complete",
  nextCursor: null,
};

describe("metadata-only Design catalog wire", () => {
  it("rejects a batch whose descriptor order disagrees with its coverage offset", () => {
    expect(
      designCatalogBatchSchema.safeParse({
        ...batch,
        total: 2,
        pages: [{ ...batch.pages[0], count: 2 }],
        frames: [{ ...batch.frames[0], order: 1 }],
        coverage: "partial",
        nextCursor: "remaining",
      }).success,
    ).toBe(false);
  });
  it("distinguishes a complete batch from the terminal fragment of a progressive read", () => {
    expect(designCatalogBatchSchema.parse(batch)).toEqual(batch);
    const last = {
      ...batch,
      offset: 1,
      total: 2,
      frames: [{ ...batch.frames[0], order: 1 }],
      pages: [{ ...batch.pages[0], count: 2 }],
      coverage: "partial",
    };
    expect(designCatalogBatchSchema.safeParse(last).success).toBe(true);
    expect(
      designCatalogBatchSchema.safeParse({ ...last, coverage: "complete" })
        .success,
    ).toBe(false);
    expect(
      designCatalogBatchSchema.safeParse({ ...batch, nextCursor: "more" })
        .success,
    ).toBe(false);
  });
  it("keeps the operation explicit and rejects old snapshots, excess fields, unsafe owners and memberships", () => {
    const input = {
      version: 1,
      workspaceId: "local",
      directoryId: "design_test",
      intent: 1,
    };
    expect(designCatalogReadSchema.parse(input)).toEqual(input);
    for (const value of [
      { ...input, version: 2 },
      { ...input, limit: 257 },
      { ...input, root: "/other" },
      { ...input, intent: -1 },
    ])
      expect(designCatalogReadSchema.safeParse(value).success).toBe(false);
    for (const value of [
      { frames: [], tokens: [], assets: [], protocolCapability: null },
      { ...batch, sourceVersion: "a".repeat(24) },
      { ...batch, owner: { ...batch.owner, placement: "cloud" } },
      { ...batch, frames: [{ ...batch.frames[0], pageId: "missing" }] },
      { ...batch, frames: [{ ...batch.frames[0], source: "../outside.html" }] },
      { ...batch, frames: [{ ...batch.frames[0], order: 1 }] },
    ])
      expect(designCatalogReplySchema.safeParse(value).success).toBe(false);
  });
  it("bounds encoded UTF-8 bytes independently of descriptor count", () => {
    const frames = Array.from({ length: 256 }, (_, i) => ({
      ...batch.frames[0],
      id: `f${i}`,
      source: `${i}${"x".repeat(1500)}.html`,
      order: i,
    }));
    expect(
      designCatalogBatchSchema.safeParse({
        ...batch,
        frames,
        total: frames.length,
        pages: [{ ...batch.pages[0], count: frames.length }],
      }).success,
    ).toBe(false);
  });
});
