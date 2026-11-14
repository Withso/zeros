import { applyDesignTransaction } from "@zeros/design-core";
import { designComponentPartNodeId, designComponentSlotNodeId } from "@zeros/protocol/design-runtime";
import { describe, expect, it } from "vitest";

import { designWebTransactionAdapter } from "../adapter";
import { designComponentBodySlots, designSlotOfNodeId, designSlottedFragment, withDesignSlotOptions, designSlotOptionElement } from "../component-slots";
import { createDesignWebDocumentState } from "../revision";
import { webTransaction } from "./fixtures";

const SOURCE = '<!doctype html><html><body><main data-oid="root"><zd-card data-oid="c1"><em data-oid="old">o</em></zd-card><p data-oid="loose">x</p></main></body></html>';
const state = (source = SOURCE) => createDesignWebDocumentState({ documentId: "slots", entryFile: "home.html", files: { "home.html": source } });
const apply = (initial: ReturnType<typeof state>, operation: Record<string, unknown>) =>
  applyDesignTransaction(initial, webTransaction(initial, "slot", [{ operationId: "op", ...operation } as never]), designWebTransactionAdapter);
const undo = (outcome: ReturnType<typeof apply>) =>
  applyDesignTransaction(outcome.state, webTransaction(outcome.state, "undo", outcome.inverseOperations), designWebTransactionAdapter);
const slot = (name: string) => designComponentSlotNodeId("c1", name);

describe("a slot id", () => {
  it("names the host and slot as the runtime does", () => {
    expect(designSlotOfNodeId(designComponentSlotNodeId("host:1", "content"))).toEqual({ host: "host:1", name: "content" });
    expect(designSlotOfNodeId(designComponentSlotNodeId("h", ""))).toEqual({ host: "h", name: "" });
    expect(designSlotOfNodeId(designComponentSlotNodeId("h", "Not A Name"))).toBeNull();
    expect(designSlotOfNodeId(designComponentPartNodeId("h", "p"))).toBeNull();
  });
});

describe("a component body's slots", () => {
  it("are its data-zd-slot frames in order, once each, but not a nested instance's", () => {
    expect(designComponentBodySlots('<div data-zd-slot="header"></div><div data-zd-slot="content"><b data-zd-slot="header"></b></div>' +
      '<zd-list><div data-zd-slot="item"></div></zd-list><div data-zd-slot="Bad Name"></div>')).toEqual(["header", "content"]);
    expect(designComponentBodySlots("<slot></slot>")).toEqual([]);
  });

  it("become slot options unless one is declared", () => {
    const declared = [{ tag: "zd-option", attributes: [{ name: "name", value: "header" }, { name: "type", value: "slot" }] }];
    expect(withDesignSlotOptions(declared, designComponentBodySlots('<div data-zd-slot="header"></div><div data-zd-slot="content"></div>'), designSlotOptionElement))
      .toEqual([...declared, designSlotOptionElement("content")]);
  });

  it("are named on each top-level layer placed in one", () => {
    expect(designSlottedFragment('<p data-oid="a">x</p> <b data-oid="b" slot="old"></b>', "content"))
      .toBe('<p slot="content" data-oid="a">x</p> <b data-oid="b" slot="content"></b>');
    expect(designSlottedFragment('<b data-oid="b" slot="old"></b>', "")).toBe('<b data-oid="b"></b>');
  });
});

describe("a write into a slot", () => {
  it("moves a layer into the host with its slot named, and undoes to the exact source", () => {
    const outcome = apply(state(), { type: "node.move", nodeId: "loose", parentId: slot("content"), beforeId: null });
    expect(outcome.receipt.status).toBe("applied");
    expect(outcome.state.files["home.html"]).toBe(
      '<!doctype html><html><body><main data-oid="root"><zd-card data-oid="c1"><em data-oid="old">o</em><p data-oid="loose" slot="content">x</p></zd-card></main></body></html>');
    expect(undo(outcome).state.files["home.html"]).toBe(SOURCE);
  });

  it("into the default slot names none, and goes before a slotted sibling but not a part", () => {
    const source = SOURCE.replace('<em data-oid="old">', '<em data-oid="old" slot="content">');
    const before = apply(state(source), { type: "node.move", nodeId: "loose", parentId: slot(""), beforeId: "old" });
    expect(before.state.files["home.html"]).toContain('<zd-card data-oid="c1"><p data-oid="loose">x</p><em data-oid="old" slot="content">o</em></zd-card>');
    const part = apply(state(source), { type: "node.move", nodeId: "loose", parentId: slot(""), beforeId: designComponentPartNodeId("c1", "frame") });
    expect(part.state.files["home.html"]).toContain('<em data-oid="old" slot="content">o</em><p data-oid="loose">x</p></zd-card>');
  });

  it("out of an instance leaves the slot behind, and undo puts it back", () => {
    const source = SOURCE.replace('<em data-oid="old">', '<em data-oid="old" slot="content">');
    const outcome = apply(state(source), { type: "node.move", nodeId: "old", parentId: "root", beforeId: null });
    expect(outcome.state.files["home.html"]).toContain('<p data-oid="loose">x</p><em data-oid="old">o</em></main>');
    expect(undo(outcome).state.files["home.html"]).toBe(source);
  });

  it("adds drawn layers to the host with the slot named, and only adds", () => {
    const outcome = apply(state(), { type: "node.set-html", nodeId: slot("content"), mode: "append", html: '<div data-oid="drawn" style="width:10px"></div>' });
    expect(outcome.receipt.status).toBe("applied");
    expect(outcome.state.files["home.html"]).toContain('<em data-oid="old">o</em><div slot="content" data-oid="drawn" style="width:10px"></div></zd-card>');
    expect(undo(outcome).state.files["home.html"]).toBe(SOURCE);
    expect(() => apply(state(), { type: "node.set-html", nodeId: slot("content"), mode: "replace-inner", html: "<b></b>" })).toThrow();
  });
});
