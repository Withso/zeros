import { describe, expect, it } from "vitest";
import {
  DESIGN_CANVAS_ITEM_LIMITS,
  designCanvasItemInputProblem,
  designCanvasItemTitle,
  designCanvasLinkTargetProblem,
  designCanvasItemBounds,
  isDesignCanvasItemSummary,
  isDesignCanvasPrivatePath,
  readDesignCanvasPageItems,
} from "../design-canvas-items";
import { designPageCatalogSchema } from "../design-pages";

const section = { id: "s1", kind: "section", x: 0, y: -40, width: 480, text: "Onboarding" };
const note = { id: "n1", kind: "note", x: 10, y: 20, width: 200, height: 120, text: "First line\nSecond line" };
const link = { id: "l1", kind: "link", x: 0, y: 300, width: 240, target: "docs/spec.md" };

describe("canvas items as written in canvas.json", () => {
  it("reads sections, notes and link cards", () => {
    const { items, issues } = readDesignCanvasPageItems([section, note, link], new Set());
    expect(items).toEqual([section, note, link]);
    expect(issues).toEqual([]);
  });

  it("reads a page without items as none, and a non-list as a reported problem", () => {
    expect(readDesignCanvasPageItems(undefined, new Set())).toEqual({ items: [], issues: [] });
    const notList = readDesignCanvasPageItems({ s1: section }, new Set());
    expect(notList.items).toEqual([]);
    expect(notList.issues).toHaveLength(1);
  });

  it("skips and reports an invalid item and keeps reading the rest", () => {
    const bad = [
      { ...section, id: "1bad" },
      { ...section, id: "s2", text: "" },
      { ...section, id: "s3", text: "Two\nlines" },
      { ...section, id: "s4", text: "x".repeat(121) },
      { ...note, id: "n2", text: "x".repeat(2_001) },
      { ...note, id: "n3", height: undefined },
      { ...note, id: "n4", width: 0 },
      { ...note, id: "n5", width: 16_385 },
      { ...note, id: "n6", x: 1_000_001 },
      { ...note, id: "n7", y: Number.NaN },
      { ...note, id: "n8", text: "bell\u0007" },
      { ...link, id: "l2", title: "t".repeat(121) },
      { ...link, id: "l3", target: "" },
      "not an item",
      null,
    ];
    const { items, issues } = readDesignCanvasPageItems([...bad, section], new Set());
    expect(items).toEqual([section]);
    expect(issues.map((issue) => issue.index)).toEqual(bad.map((_, index) => index));
    expect(issues.every((issue) => issue.kind === "invalid")).toBe(true);
  });

  it("keeps a note's line breaks and counts characters, not code units", () => {
    const emoji = "\u{1F600}".repeat(DESIGN_CANVAS_ITEM_LIMITS.noteText);
    const { items } = readDesignCanvasPageItems([{ ...note, text: emoji }, { ...note, id: "n2", text: "a\n\nb\tc" }], new Set());
    expect(items.map((item) => item.kind === "note" && item.text)).toEqual([emoji, "a\n\nb\tc"]);
  });

  it("keeps an unknown kind out of the drawn items, reported as kept", () => {
    const { items, issues } = readDesignCanvasPageItems([{ id: "u1", kind: "sticker", x: 0, y: 0 }, section], new Set());
    expect(items).toEqual([section]);
    expect(issues).toEqual([expect.objectContaining({ index: 0, id: "u1", kind: "unknown" })]);
  });

  it("refuses an id a frame or an earlier item already has, across pages", () => {
    const reserved = new Set(["home"]);
    const first = readDesignCanvasPageItems([{ ...section, id: "home" }, section, { ...note, id: "s1" }], reserved);
    expect(first.items).toEqual([section]);
    expect(first.issues.map((issue) => issue.index)).toEqual([0, 2]);
    // The ids read on one page stay taken for the next.
    expect(readDesignCanvasPageItems([section], reserved).items).toEqual([]);
  });

  it("takes an inherited object name as an ordinary id", () => {
    const reserved = new Set<string>();
    const { items } = readDesignCanvasPageItems(["constructor", "toString", "hasOwnProperty"].map((id) => ({ ...section, id })), reserved);
    expect(items.map((item) => item.id)).toEqual(["constructor", "toString", "hasOwnProperty"]);
  });

  it("reads at most 256 items and 256 KiB of item text on a page", () => {
    const many = Array.from({ length: 258 }, (_, index) => ({ ...section, id: `s${index}` }));
    const counted = readDesignCanvasPageItems(many, new Set());
    expect(counted.items).toHaveLength(256);
    expect(counted.issues).toEqual([expect.objectContaining({ kind: "limit" })]);
    // 2,000 four-byte characters a note: 32 notes is 256,000 bytes, the 33rd passes the cap.
    const heavy = Array.from({ length: 34 }, (_, index) => ({ ...note, id: `n${index}`, text: "\u{1F600}".repeat(2_000) }));
    const weighed = readDesignCanvasPageItems(heavy, new Set());
    expect(weighed.items).toHaveLength(32);
    expect(weighed.issues).toEqual([expect.objectContaining({ kind: "limit" })]);
  });

  it("titles a link card by the file name unless it has its own", () => {
    expect(designCanvasItemTitle({ ...link, kind: "link" })).toBe("spec.md");
    expect(designCanvasItemTitle({ ...link, kind: "link", title: "The spec" })).toBe("The spec");
  });

  it("gives every item finite bounds for culling", () => {
    expect(designCanvasItemBounds({ ...section, kind: "section" })).toEqual({ x: 0, y: -40, width: 480, height: 28 });
    expect(designCanvasItemBounds({ ...note, kind: "note" })).toEqual({ x: 10, y: 20, width: 200, height: 120 });
    expect(designCanvasItemBounds({ ...link, kind: "link" })).toEqual({ x: 0, y: 300, width: 240, height: 56 });
  });
});

describe("a link card's target", () => {
  it.each(["docs/spec.md", "README.md", "a/b/c-d_e.f.tsx", "Design/home.html", "notes/.prettierrc"])("accepts %j", (target) => {
    expect(designCanvasLinkTargetProblem(target)).toBeNull();
  });

  it.each([
    "", "/etc/passwd", "~/notes.md", "docs\\spec.md", "docs//spec.md", "docs/./spec.md", "../outside.md", "docs/../../x",
    "docs/", ".", "https://example.test/x", "file:spec.md", "C:/x", "mailto:a", "a\u0000b", "a\nb", "a\u007fb", "a\u0085b",
    ".git/config", "src/.git/HEAD", ".zeros/state.json", ".env", "app/.env.local", ".ENV", ".npmrc", ".yarnrc.yml",
    ".context/x", ".conductor/y", "zeros-dev-env.json", "certs/server.pem", "id.key", "data/app.sqlite", "app.db-wal",
    "x".repeat(DESIGN_CANVAS_ITEM_LIMITS.linkTarget + 1),
  ])("refuses %j", (target) => {
    expect(designCanvasLinkTargetProblem(target)).not.toBeNull();
  });

  it("treats as private exactly what the development servers deny", async () => {
    const { isPrivateDevPath } = await import("../../../../scripts/dev-server-policy.mjs");
    for (const target of [".git/config", "a/.ENV.local", "x.PEM", "db/app.db-shm", "src/app.ts", "docs/key.md", "env/file", ".envrc", "a.keys"])
      expect([target, isDesignCanvasPrivatePath(target)]).toEqual([target, isPrivateDevPath(target)]);
  });

  it("refuses a link whose target is unsafe as its own kind of problem", () => {
    const { issues } = readDesignCanvasPageItems([{ ...link, target: "../secret" }], new Set());
    expect(issues).toEqual([expect.objectContaining({ index: 0, kind: "unsafe-link" })]);
  });

  it("checks a long target in time linear in its length", () => {
    const started = performance.now();
    for (let index = 0; index < 200; index++) designCanvasLinkTargetProblem("a/".repeat(255) + "b");
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("what the canvas may write", () => {
  it("accepts each kind with only its own fields", () => {
    expect(designCanvasItemInputProblem({ kind: "section", x: 0, y: 0, width: 200, text: "Flow" })).toBeNull();
    expect(designCanvasItemInputProblem({ id: "n1", kind: "note", x: 0, y: 0, width: 200, height: 80, text: "" })).toBeNull();
    expect(designCanvasItemInputProblem({ kind: "link", x: 0, y: 0, width: 240, target: "README.md", title: "Read me" })).toBeNull();
  });

  it("refuses unknown fields, a summary's missing mark, or a field of another kind", () => {
    expect(designCanvasItemInputProblem({ kind: "section", x: 0, y: 0, width: 200, text: "Flow", height: 10 })).not.toBeNull();
    expect(designCanvasItemInputProblem({ kind: "link", x: 0, y: 0, width: 240, target: "README.md", missing: true })).not.toBeNull();
    expect(designCanvasItemInputProblem({ kind: "note", x: 0, y: 0, width: 200, height: 80, text: "", color: "yellow" })).not.toBeNull();
    expect(designCanvasItemInputProblem({ kind: "sticker", x: 0, y: 0 })).not.toBeNull();
    expect(designCanvasItemInputProblem({ kind: "link", x: 0, y: 0, width: 240, target: "../x" })).not.toBeNull();
  });
});

describe("items on the wire", () => {
  const page = { id: "page_1", title: "Page 1", folder: "page-1", frameFiles: ["page-1/home.html"], frameIds: ["home"] };

  it("carries valid items on a page summary, a missing link marked as such", () => {
    const items = [section, { ...link, missing: true }];
    expect(designPageCatalogSchema.parse([{ ...page, items }])[0]!.items).toEqual(items);
    expect(isDesignCanvasItemSummary({ ...link, missing: true })).toBe(true);
    expect(isDesignCanvasItemSummary({ ...section, missing: true })).toBe(false);
  });

  it("refuses a page whose items are invalid, too many, or share an id", () => {
    expect(designPageCatalogSchema.safeParse([{ ...page, items: [{ ...section, text: "" }] }]).success).toBe(false);
    expect(designPageCatalogSchema.safeParse([{ ...page, items: [section, { ...note, id: "s1" }] }]).success).toBe(false);
    expect(designPageCatalogSchema.safeParse([{ ...page, items: [{ ...section, id: "home" }] }]).success).toBe(false);
    const many = Array.from({ length: 257 }, (_, index) => ({ ...section, id: `s${index}` }));
    expect(designPageCatalogSchema.safeParse([{ ...page, items: many }]).success).toBe(false);
  });
});
