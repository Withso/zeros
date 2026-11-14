import { applyDesignTransaction } from "@zeros/design-core";
import { designComponentPartNodeId } from "@zeros/protocol/design-runtime";
import { describe, expect, it } from "vitest";

import { designWebTransactionAdapter } from "../adapter";
import { applyDesignPartStyleOverrides, designPartOfNodeId, designPartStyleAttribute, mergeDesignPartStyleOverride } from "../component-overrides";
import { createDesignWebDocumentState } from "../revision";
import { webTransaction } from "./fixtures";

const SOURCE = '<!doctype html><html><body><main data-oid="root"><zd-card data-oid="c1" heading="Hi"></zd-card></main></body></html>';
const state = (source = SOURCE) => createDesignWebDocumentState({ documentId: "overrides", entryFile: "home.html", files: { "home.html": source } });
const setStyles = (initial: ReturnType<typeof state>, part: string, styles: Record<string, string | null>) =>
  applyDesignTransaction(initial, webTransaction(initial, "part-style", [{
    operationId: "style", type: "node.set-styles", nodeId: designComponentPartNodeId("c1", part), styles,
    scope: "auto", responsiveContext: "base", stateContext: "default",
  }]), designWebTransactionAdapter);

describe("a part's style write", () => {
  it("sets the host's zd-style-<part> and undoes to the exact source", () => {
    const initial = state();
    const outcome = setStyles(initial, "card-title", { color: "red", "padding-top": "4px" });
    expect(outcome.receipt.status).toBe("applied");
    expect(outcome.state.files["home.html"]).toBe(
      '<!doctype html><html><body><main data-oid="root"><zd-card data-oid="c1" heading="Hi" zd-style-card-title="color: red; padding-top: 4px"></zd-card></main></body></html>');
    const restored = applyDesignTransaction(outcome.state, webTransaction(outcome.state, "undo", outcome.inverseOperations), designWebTransactionAdapter);
    expect(restored.state.files["home.html"]).toBe(SOURCE);
  });

  it("replaces a property it set, removes one set to null, and drops the attribute when nothing is left", () => {
    const initial = state(SOURCE.replace('heading="Hi"', 'heading="Hi" zd-style-chip="color: red; margin: 0"'));
    const changed = setStyles(initial, "chip#1", { color: "blue", margin: null });
    expect(changed.state.files["home.html"]).toContain('zd-style-chip="color: blue"');
    const cleared = setStyles(changed.state, "chip", { color: null });
    expect(cleared.state.files["home.html"]).toBe(SOURCE);
  });

  it("refuses a value the Style panel could not write inline, and a part no attribute can name", () => {
    expect(() => setStyles(state(), "card", { color: "red; background: url(x)" })).toThrow();
    expect(() => setStyles(state(), "Has Space", { color: "red" })).toThrow(/part/i);
  });

  it("writes no other layer's id", () => {
    const outcome = setStyles(state('<!doctype html><html><body><main><zd-card data-oid="c1"></zd-card><p>x</p></main></body></html>'), "card", { color: "red" });
    expect(outcome.state.files["home.html"]).toBe('<!doctype html><html><body><main><zd-card data-oid="c1" zd-style-card="color: red"></zd-card><p>x</p></main></body></html>');
  });
});

describe("part overrides", () => {
  it("name a part as the runtime does", () => {
    expect(designPartOfNodeId(designComponentPartNodeId("host:1", "chip#2"))).toEqual({ host: "host:1", part: "chip#2" });
    expect(designPartOfNodeId("c1")).toBeNull();
    expect(designPartStyleAttribute("Chip#3")).toBe("zd-style-chip");
    expect(designPartStyleAttribute("a b")).toBeNull();
  });

  it("merge declarations without splitting a value's own semicolons", () => {
    expect(mergeDesignPartStyleOverride('background: url("a;b.png"); color: red', new Map([["color", "blue"]])))
      .toBe('background: url("a;b.png"); color: blue');
  });

  it("add to a void part's start tag", () => {
    expect(applyDesignPartStyleOverrides('<img data-zd-part="pic" src="a.png" />', new Map([["pic", 'width: 4px; content: "x"']])))
      .toBe('<img data-zd-part="pic" src="a.png" style="width: 4px; content: &quot;x&quot;" />');
  });
});
