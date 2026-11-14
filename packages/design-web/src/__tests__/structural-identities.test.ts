import { applyDesignTransaction, type DesignOperation } from "@zeros/design-core";
import { describe, expect, it } from "vitest";

import { designWebTransactionAdapter, readDesignWebProjection } from "../adapter";
import type { DesignWebDocumentState } from "../model";
import { createDesignWebDocumentState } from "../revision";
import { webTransaction } from "./fixtures";

const page = (body: string) => `<!doctype html><html><body>\n${body}\n</body></html>`;
const state = (source: string) => createDesignWebDocumentState({ documentId: "ids", entryFile: "home.html", files: { "home.html": source } });
const apply = (initial: DesignWebDocumentState, operation: DesignOperation) => {
  const outcome = applyDesignTransaction(initial, webTransaction(initial, "edit", [operation]), designWebTransactionAdapter);
  expect(outcome.receipt.status).toBe("applied");
  const undone = applyDesignTransaction(outcome.state, webTransaction(outcome.state, "undo", outcome.inverseOperations), designWebTransactionAdapter);
  expect(undone.state.files["home.html"]).toBe(initial.files["home.html"]);
  return outcome.state;
};
/** Each layer's id, keyed by its own text (or its class when it has none). */
const idsByLabel = (current: DesignWebDocumentState) => {
  const projection = readDesignWebProjection(current);
  return new Map(projection.nodes.map((node) => [node.directText.trim() || node.attributes.class || node.tag, node.id]));
};
const written = (current: DesignWebDocumentState) => [...current.files["home.html"]!.matchAll(/data-oid="([^"]+)"/g)].map((match) => match[1]);

const SOURCE = page([
  "<main>",
  '  <section class="a"><p>One</p><p>Two</p></section>',
  '  <section class="b"><p>Three</p></section>',
  "  <footer><p>Four</p></footer>",
  "</main>",
].join("\n"));

describe("a structural edit's layer ids", () => {
  it("are written only on the layers whose place shifts, and each keeps its own id", () => {
    const initial = state(SOURCE);
    const before = idsByLabel(initial);
    const after = apply(initial, { operationId: "d", type: "node.delete", nodeId: before.get("a")! });
    expect(new Set(written(after))).toEqual(new Set(["b", "Three", "footer", "Four"].map((label) => before.get(label))));
    const now = idsByLabel(after);
    for (const label of ["main", "b", "Three", "footer", "Four"]) expect(now.get(label)).toBe(before.get(label));
  });

  it("write nothing beyond the layer itself when nothing after it shifts", () => {
    const initial = state(SOURCE);
    const before = idsByLabel(initial);
    const after = apply(initial, { operationId: "d", type: "node.delete", nodeId: before.get("footer")! });
    expect(after.files["home.html"]).toBe(SOURCE.replace("  <footer><p>Four</p></footer>\n", ""));
  });

  it("follow a reordered layer and the sibling it passes, not the rest", () => {
    const initial = state(SOURCE);
    const before = idsByLabel(initial);
    const after = apply(initial, { operationId: "m", type: "node.move", nodeId: before.get("Two")!, parentId: before.get("a")!, beforeId: before.get("One")! });
    expect(new Set(written(after))).toEqual(new Set([before.get("Two"), before.get("One"), before.get("a")]));
    expect(idsByLabel(after)).toEqual(before);
  });

  it("stay with each layer when two alike layers trade places", () => {
    const initial = state(page('<main><div class="x"><p>1</p></div><div class="x"><p>2</p></div></main>'));
    const projection = readDesignWebProjection(initial);
    const [main, first, , second] = projection.nodes;
    const after = apply(initial, { operationId: "m", type: "node.move", nodeId: second!.id, parentId: main!.id, beforeId: first!.id });
    const nodes = readDesignWebProjection(after).nodes;
    const parentOf = (text: string) => nodes.find((node) => node.childIds.includes(nodes.find((child) => child.directText === text)!.id))!.id;
    expect(parentOf("1")).toBe(first!.id);
    expect(parentOf("2")).toBe(second!.id);
  });

  it("write only the container's id and the new content's when content is added at its end", () => {
    const initial = state(SOURCE);
    const before = idsByLabel(initial);
    const after = apply(initial, { operationId: "h", type: "node.set-html", nodeId: before.get("a")!, html: "<p>Extra</p>", mode: "append" });
    const extra = idsByLabel(after).get("Extra")!;
    expect(written(after)).toEqual([before.get("a"), extra]);
    expect(after.files["home.html"]).toContain(`<p>Two</p><p data-oid="${extra}">Extra</p></section>`);
  });

  it("give a duplicate's copy its own ids, as the canvas names them, beside a sibling just like it", () => {
    const initial = state(page("<ul><li><span>A</span><button>Buy</button></li><li><span>B</span><button>Buy</button></li></ul>"));
    const [, first, label, button] = readDesignWebProjection(initial).nodes;
    const after = apply(initial, { operationId: "c", type: "node.duplicate", nodeId: first!.id, duplicateNodeId: "copy" });
    const projection = readDesignWebProjection(after);
    expect(projection.diagnostics).toEqual([]);
    expect(projection.nodes).toHaveLength(10);
    // The runtime's clone names each copied layer <copy>-<original>.
    expect(projection.nodes.map((node) => node.id)).toEqual(expect.arrayContaining([`copy-${label!.id}`, `copy-${button!.id}`]));
    expect(idsByLabel(after).get("Buy")).toBeDefined();
  });

  it("leave a duplicate's original in place and write the layers after it", () => {
    const initial = state(SOURCE);
    const before = idsByLabel(initial);
    const after = apply(initial, { operationId: "c", type: "node.duplicate", nodeId: before.get("b")!, duplicateNodeId: "copy" });
    const ids = written(after);
    expect(ids).toContain("copy");
    expect(ids).not.toContain(before.get("One"));
    expect(ids).not.toContain(before.get("main"));
    expect(ids).toContain(before.get("footer"));
    const now = idsByLabel(after);
    for (const label of ["main", "a", "One", "Two", "footer", "Four"]) expect(now.get(label)).toBe(before.get(label));
  });
});
