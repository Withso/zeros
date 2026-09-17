import { describe, expect, it } from "vitest";
import { mutateDesignNodeMoveSource } from "../html";

const source =
  '<!doctype html><html><body><main data-oid="root"><div data-oid="a"><span data-oid="text">Keep &amp; preserve</span></div>\n<!-- keep --><div data-oid="b"></div><section data-oid="nested"></section></main></body></html>';
describe("moving authored layers", () => {
  it("moves the exact source subtree without changing IDs or neighboring bytes", () => {
    const moved = mutateDesignNodeMoveSource(source, "a", "nested", null);
    expect(moved).toContain(
      '<section data-oid="nested"><div data-oid="a"><span data-oid="text">Keep &amp; preserve</span></div></section>',
    );
    expect(moved).toContain('\n<!-- keep --><div data-oid="b">');
    expect(mutateDesignNodeMoveSource(moved, "a", "root", "b")).toContain(
      '<div data-oid="a"><span data-oid="text">Keep &amp; preserve</span></div><div data-oid="b">',
    );
  });
  it("rejects self-nesting, descendants, and a sibling from another parent", () => {
    expect(() => mutateDesignNodeMoveSource(source, "a", "a", null)).toThrow();
    expect(() =>
      mutateDesignNodeMoveSource(source, "a", "text", null),
    ).toThrow();
    expect(() =>
      mutateDesignNodeMoveSource(source, "a", "nested", "b"),
    ).toThrow();
  });
  it("supports appending at document level and keeps same-position moves unchanged", () => {
    expect(mutateDesignNodeMoveSource(source, "nested", "root", null)).toBe(
      source,
    );
    expect(
      mutateDesignNodeMoveSource(source, "a", "::zeros-document-body", null),
    ).toContain('</main><div data-oid="a">');
  });
});
