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

describe("moving a layer that has its own line", () => {
  const indented = [
    "<!doctype html><html><body>",
    '<main data-oid="root">',
    '  <h1 data-oid="title">Title</h1>',
    '  <p data-oid="one">One</p>',
    '  <p data-oid="two">Two</p>',
    "</main>",
    "</body></html>",
  ].join("\n");

  it("reorders whole lines, leaving no blank line and no shared line", () => {
    expect(mutateDesignNodeMoveSource(indented, "title", "root", null)).toBe(
      [
        "<!doctype html><html><body>",
        '<main data-oid="root">',
        '  <p data-oid="one">One</p>',
        '  <p data-oid="two">Two</p>',
        '  <h1 data-oid="title">Title</h1>',
        "</main>",
        "</body></html>",
      ].join("\n"),
    );
    expect(mutateDesignNodeMoveSource(indented, "two", "root", "title")).toBe(
      [
        "<!doctype html><html><body>",
        '<main data-oid="root">',
        '  <p data-oid="two">Two</p>',
        '  <h1 data-oid="title">Title</h1>',
        '  <p data-oid="one">One</p>',
        "</main>",
        "</body></html>",
      ].join("\n"),
    );
  });

  it("keeps CRLF line endings on the moved line", () => {
    const crlf = indented.replaceAll("\n", "\r\n");
    const moved = mutateDesignNodeMoveSource(crlf, "title", "root", null);
    expect(moved).not.toMatch(/(^|[^\r])\n/);
    expect(moved).toBe(mutateDesignNodeMoveSource(indented, "title", "root", null).replaceAll("\n", "\r\n"));
    expect(mutateDesignNodeMoveSource(moved, "title", "root", "one")).toBe(crlf);
  });

  it("moving back restores the exact source", () => {
    const moved = mutateDesignNodeMoveSource(indented, "title", "root", null);
    expect(mutateDesignNodeMoveSource(moved, "title", "root", "one")).toBe(indented);
  });

  it("takes its line along when the destination closes on the same line", () => {
    const inline = indented.replace("</main>", '  <section data-oid="nested"></section>\n</main>');
    expect(mutateDesignNodeMoveSource(inline, "title", "nested", null)).toBe(
      [
        "<!doctype html><html><body>",
        '<main data-oid="root">',
        '  <p data-oid="one">One</p>',
        '  <p data-oid="two">Two</p>',
        '  <section data-oid="nested"><h1 data-oid="title">Title</h1></section>',
        "</main>",
        "</body></html>",
      ].join("\n"),
    );
  });
});
