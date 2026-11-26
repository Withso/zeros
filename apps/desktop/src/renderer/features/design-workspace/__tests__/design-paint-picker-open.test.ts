// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesignColorField, requestDesignPaintPicker } from "../design-color-picker";
import { DesignFillEditor } from "../design-fill-editor";
import { DesignStrokeSection } from "../design-stroke-editor";
import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

const fill = () => createElement(DesignFillEditor, {
  color: "#D9D9D9", // check:ui ignore-line -- authored paint fixture
  image: "none", position: "0% 0%", size: "auto", repeat: "repeat", onCommit: () => {},
});
const stroke = (property: string) => createElement(DesignColorField, {
  value: "#000000", // check:ui ignore-line -- authored paint fixture
  label: "Stroke", property, onCommit: () => {},
});
const popover = () => document.querySelector("[data-design-popover]");

describe("an added paint row", () => {
  it("opens the new fill's picker as it appears, once", async () => {
    requestDesignPaintPicker("background-color");
    await act(async () => root.render(fill()));
    expect(popover()).not.toBeNull();
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => root.render(fill()));
    expect(popover()).toBeNull();
  });

  it("opens only the row for the paint that was added", async () => {
    requestDesignPaintPicker("outline-color");
    await act(async () => root.render(stroke("border-color")));
    expect(popover()).toBeNull();
    await act(async () => root.render(createElement("div", null, stroke("border-color"), stroke("outline-color"))));
    expect(document.querySelector("[data-design-popover] .zd-popover-title")?.textContent).toBe("Stroke");
  });

  it("shows an added stroke row with its picker before the save lands, and drops it if the save fails", async () => {
    const details = { oid: "card", sourceVersion: "a".repeat(24), tag: "div", name: "Card", text: null, selector: "", visible: true,
      breadcrumb: [], rect: { x: 0, y: 0, width: 80, height: 40 },
      styles: { borderStyle: "none", borderWidth: "0px", outlineStyle: "none", outlineWidth: "0px" } } as unknown as DesignRuntimeNodeDetails;
    let reject!: (error: Error) => void;
    const onCommit = vi.fn(() => new Promise((_, fail) => { reject = fail; }));
    await act(async () => root.render(createElement(DesignStrokeSection, {
      details, renderField: (label: string, _property: string, value: string) => createElement("span", { "data-field": label }, value), onCommit,
    })));
    expect(document.querySelector("[data-design-stroke]")).toBeNull();
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Add stroke"]')!.click());
    expect(onCommit).toHaveBeenCalledWith(expect.objectContaining({ "border-width": "1px" }), "stroke");
    expect(document.querySelector('[data-design-stroke="border"] [data-field="Stroke weight"]')?.textContent).toBe("1px");
    expect(popover()).not.toBeNull();
    await act(async () => reject(new Error("conflict")));
    expect(document.querySelector("[data-design-stroke]")).toBeNull();
  });

  it("ignores a request whose row never appeared promptly", async () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(1_000);
    requestDesignPaintPicker("background-color");
    now.mockReturnValue(10_000);
    await act(async () => root.render(fill()));
    expect(popover()).toBeNull();
  });
});
