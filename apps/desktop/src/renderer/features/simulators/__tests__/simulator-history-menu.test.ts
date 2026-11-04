// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SimulatorAnnotateToolbar } from "../simulator-annotator";
import { simulatorAnnotations } from "../simulator-annotation-store";
import { dispatchFocusedEditHistory } from "../../../shared/ui/edit-history";
import type { SimulatorAnnotationSnapshot } from "@zeros/protocol/simulator-captures";

const fixture = vi.hoisted(() => ({ snapshot: {
  png: new Uint8Array([137, 80, 78, 71]), widthPx: 402, heightPx: 874,
  width: 402, height: 874, orientation: "portrait", deviceName: "Phone",
  osLabel: "iOS", appName: "Settings", appId: "app.test", elements: [],
} as SimulatorAnnotationSnapshot }));
vi.mock("../simulator-api", () => ({ loadSimulatorAnnotationSnapshot: async () => fixture.snapshot }));
vi.mock("../simulator-annotation-actions", () => ({ addAnnotationToChat: vi.fn(), leaveSimulatorAnnotation: vi.fn() }));

let root: Root;
let host: HTMLDivElement;
const tab = "history-simulator";
const marks = () => simulatorAnnotations.get(tab)!.history.marks;
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{ width: 100, height: 20 }] as unknown as DOMRectList);
  await simulatorAnnotations.begin(tab, { id: "device", name: "Phone" });
  simulatorAnnotations.commit(tab, () => [{ kind: "rectangle", color: "red", note: "", from: { x: 1, y: 1 }, to: { x: 20, y: 20 } }]);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(SimulatorAnnotateToolbar, { annotation: { ...simulatorAnnotations.get(tab)!, snapshot: fixture.snapshot } })));
  host.querySelector<HTMLButtonElement>('button[aria-label="Pen"]')!.focus();
});
afterEach(() => {
  act(() => root.unmount());
  simulatorAnnotations.end(tab);
  host.remove();
  vi.restoreAllMocks();
});

describe("simulator annotation history ownership", () => {
  it("routes menu Undo and Redo to the focused annotation toolbar", () => {
    act(() => { expect(dispatchFocusedEditHistory("undo")).toBe("handled"); });
    expect(marks()).toHaveLength(0);
    act(() => { expect(dispatchFocusedEditHistory("redo")).toBe("handled"); });
    expect(marks()).toHaveLength(1);
  });

  it("supports Windows Ctrl+Y as well as Ctrl+Shift+Z", () => {
    const target = document.activeElement!;
    act(() => target.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true })));
    expect(marks()).toHaveLength(0);
    act(() => target.dispatchEvent(new KeyboardEvent("keydown", { key: "y", ctrlKey: true, bubbles: true, cancelable: true })));
    expect(marks()).toHaveLength(1);
  });

  it("leaves native note fields and hidden annotations alone", () => {
    const note = document.createElement("input");
    host.querySelector("[data-simulator-annotate]")!.append(note);
    note.focus();
    expect(dispatchFocusedEditHistory("undo")).toBe("native");
    expect(marks()).toHaveLength(1);
    note.readOnly = true;
    expect(dispatchFocusedEditHistory("undo")).toBe("none");
    expect(marks()).toHaveLength(1);
    host.setAttribute("inert", "");
    expect(dispatchFocusedEditHistory("undo")).toBe("none");
    expect(marks()).toHaveLength(1);
  });
});
