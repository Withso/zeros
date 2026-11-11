// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  OptionActionRow,
  OptionEntryRow,
  OptionGroupHeading,
  OptionNumberRow,
  OptionRangeRow,
  OptionRow,
  OptionSegmentedRow,
  OptionSwitchRow,
  OptionTextRow,
} from "../option-row";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const render = (element: ReturnType<typeof createElement>) => act(() => root.render(element));
const key = (target: Element, name: string, init: KeyboardEventInit = {}) =>
  act(() => { target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, ...init })); });
const pointer = (target: Element, type: string, clientX: number) =>
  act(() => { target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX, button: 0 }) as unknown as PointerEvent); });

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("an option row", () => {
  it("is one 32px row on bg2 in the interface font, its value in tabular figures", () => {
    render(createElement(OptionRow, { label: "Toolbar" }, "On"));
    const row = host.querySelector("[data-option-row]")!;
    for (const cls of ["h-8", "bg-bg2", "rounded-md", "text-xs", "leading-4.5"]) expect(row.classList, cls).toContain(cls);
    expect(row.className).not.toMatch(/font-mono/);
    expect(host.querySelector("[data-option-row-label]")!.classList).toContain("text-fg2");
    expect(host.querySelector("[data-option-row-value]")!.classList).toContain("tabular-nums");
  });
});

describe("a number with a range", () => {
  const props = { label: "Width", value: 1120, min: 600, max: 1600, unit: "px" };

  it("is a slider: its name, range and value, and a fill for the value", () => {
    render(createElement(OptionRangeRow, { ...props, onCommit: () => {} }));
    const slider = host.querySelector('[role="slider"]')!;
    expect(slider.getAttribute("aria-label")).toBe("Width");
    expect([slider.getAttribute("aria-valuemin"), slider.getAttribute("aria-valuemax"), slider.getAttribute("aria-valuenow")]).toEqual(["600", "1600", "1120"]);
    expect(slider.getAttribute("aria-valuetext")).toBe("1120 px");
    expect((host.querySelector("[data-option-row-fill]") as HTMLElement).style.width).toBe("52%");
    expect(host.querySelector("[data-option-row-value]")!.textContent).toBe("1120px");
  });

  it("steps by one with the arrows, ten with Shift, to the ends with Home and End, a commit each", () => {
    const onCommit = vi.fn();
    render(createElement(OptionRangeRow, { ...props, onCommit }));
    const slider = host.querySelector('[role="slider"]')!;
    key(slider, "ArrowRight");
    key(slider, "ArrowLeft", { shiftKey: true });
    key(slider, "End");
    key(slider, "Home");
    expect(onCommit.mock.calls.map(([value]) => value)).toEqual([1121, 1111, 1600, 600]);
  });

  it("steps by its own step, from its minimum", () => {
    const onCommit = vi.fn();
    render(createElement(OptionRangeRow, { ...props, step: 8, onCommit }));
    key(host.querySelector('[role="slider"]')!, "ArrowUp");
    expect(onCommit).toHaveBeenCalledWith(1128);
  });

  it("previews while dragged anywhere on the row, in whole numbers, and commits once on release", () => {
    const onPreview = vi.fn();
    const onCommit = vi.fn();
    render(createElement(OptionRangeRow, { ...props, onPreview, onCommit }));
    const slider = host.querySelector('[role="slider"]') as HTMLElement;
    slider.getBoundingClientRect = () => ({ left: 0, width: 200, right: 200, top: 0, bottom: 32, height: 32, x: 0, y: 0, toJSON: () => ({}) });
    pointer(slider, "pointerdown", 104);
    pointer(slider, "pointermove", 110);
    pointer(slider, "pointermove", 151);
    pointer(slider, "pointerup", 151);
    expect(onPreview.mock.calls.map(([value]) => value)).toEqual([1150, 1355]);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(1355);
  });

  it("restores its value and commits nothing when Escape ends a drag", () => {
    const onCancel = vi.fn();
    const onCommit = vi.fn();
    render(createElement(OptionRangeRow, { ...props, onPreview: () => {}, onCancel, onCommit }));
    const slider = host.querySelector('[role="slider"]') as HTMLElement;
    slider.getBoundingClientRect = () => ({ left: 0, width: 200, right: 200, top: 0, bottom: 32, height: 32, x: 0, y: 0, toJSON: () => ({}) });
    pointer(slider, "pointerdown", 100);
    pointer(slider, "pointermove", 180);
    key(slider, "Escape");
    pointer(slider, "pointerup", 180);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
    expect(slider.getAttribute("aria-valuenow")).toBe("1120");
  });

  it("types a value when its value is clicked, clamped to the range", () => {
    const onCommit = vi.fn();
    render(createElement(OptionRangeRow, { ...props, onCommit }));
    const value = host.querySelector("[data-option-row-value]") as HTMLElement;
    pointer(value, "pointerdown", 190);
    pointer(value, "pointerup", 190);
    act(() => value.click());
    const input = host.querySelector("input") as HTMLInputElement;
    expect(input.value).toBe("1120");
    act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "2000"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    key(input, "Enter");
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(1600);
  });

  it("does nothing while disabled", () => {
    const onCommit = vi.fn();
    render(createElement(OptionRangeRow, { ...props, disabled: true, onCommit }));
    const slider = host.querySelector('[role="slider"]')!;
    expect(slider.getAttribute("aria-disabled")).toBe("true");
    key(slider, "ArrowRight");
    expect(onCommit).not.toHaveBeenCalled();
  });
});

describe("the other rows", () => {
  it("a number without a range is a field typed in place", () => {
    const onCommit = vi.fn();
    render(createElement(OptionNumberRow, { label: "Gap", value: 8, unit: "px", onCommit }));
    const input = host.querySelector("input")!;
    expect(input.getAttribute("aria-label")).toBe("Gap");
    expect(input.classList).toContain("text-right");
    key(input, "ArrowUp");
    expect(onCommit).toHaveBeenCalledWith(9);
  });

  it("on or off is the app's switch at the row's end", () => {
    const onCommit = vi.fn();
    render(createElement(OptionSwitchRow, { label: "Toolbar", value: true, onCommit }));
    const toggle = host.querySelector('[role="switch"]') as HTMLButtonElement;
    expect(toggle.getAttribute("aria-label")).toBe("Toolbar");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    act(() => toggle.click());
    expect(onCommit).toHaveBeenCalledWith(false);
  });

  it("a few choices sit in the row as radios", () => {
    const onCommit = vi.fn();
    render(createElement(OptionSegmentedRow, { label: "Mode", value: "ask", choices: [{ value: "ask", label: "Ask" }, { value: "plan", label: "Plan" }], onCommit }));
    const group = host.querySelector('[role="radiogroup"]')!;
    expect(group.getAttribute("aria-label")).toBe("Mode");
    const radios = [...host.querySelectorAll('[role="radio"]')] as HTMLButtonElement[];
    expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    act(() => radios[1]!.click());
    expect(onCommit).toHaveBeenCalledWith("plan");
    key(radios[0]!, "ArrowRight");
    expect(onCommit).toHaveBeenLastCalledWith("plan");
  });

  it("text is typed in place, right aligned, and committed on Enter", () => {
    const onCommit = vi.fn();
    render(createElement(OptionTextRow, { label: "Label", value: "Send", onCommit }));
    const input = host.querySelector("input") as HTMLInputElement;
    expect(input.classList).toContain("text-right");
    act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Go"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    key(input, "Enter");
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("Go");
  });

  it("a group heading folds", () => {
    const onToggle = vi.fn();
    render(createElement(OptionGroupHeading, { label: "Send button", expanded: true, onToggle }));
    const heading = host.querySelector("button")!;
    expect(heading.getAttribute("aria-expanded")).toBe("true");
    act(() => heading.click());
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("an action row is one centred button", () => {
    const onClick = vi.fn();
    render(createElement(OptionActionRow, { onClick }, "Ask agent to change options"));
    const button = host.querySelector("button")!;
    expect(button.classList).toContain("justify-center");
    act(() => button.click());
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("a row whose value differs from what it inherits", () => {
  it("carries the blue dot at its corner, in every kind, and none otherwise", () => {
    const rows = [
      createElement(OptionRow, { key: "row", label: "Row", changed: true }, "x"),
      createElement(OptionRangeRow, { key: "range", label: "Width", value: 1, min: 0, max: 2, changed: true, onCommit: () => {} }),
      createElement(OptionNumberRow, { key: "number", label: "Gap", value: 1, changed: true, onCommit: () => {} }),
      createElement(OptionSwitchRow, { key: "switch", label: "Toolbar", value: true, changed: true, onCommit: () => {} }),
      createElement(OptionSegmentedRow, { key: "segments", label: "Mode", value: "a", choices: [{ value: "a", label: "A" }], changed: true, onCommit: () => {} }),
      createElement(OptionTextRow, { key: "text", label: "Label", value: "Go", changed: true, onCommit: () => {} }),
      createElement(OptionRangeRow, { key: "plain", label: "Plain", value: 1, min: 0, max: 2, onCommit: () => {} }),
    ];
    render(createElement("div", null, rows));
    const dots = host.querySelectorAll("[data-option-changed]");
    expect(dots).toHaveLength(6);
    for (const cls of ["bg-blue-primary", "size-1", "rounded-full", "absolute"]) expect(dots[0]!.classList, cls).toContain(cls);
    expect(host.querySelector('[aria-label="Plain"] [data-option-changed]')).toBeNull();
  });
});

describe("a name typed in place", () => {
  it("submits on Enter, says why a name is refused, and leaves on Escape or an empty blur", () => {
    const submitted: string[] = [];
    const cancels = vi.fn();
    render(createElement(OptionEntryRow, { label: "Name", inputLabel: "Variant name", placeholder: "Compact",
      onSubmit: (text: string) => (submitted.push(text), text === "Bad" ? "That name is taken." : null), onCancel: cancels }));
    const input = host.querySelector("input")!;
    expect(input.getAttribute("aria-label")).toBe("Variant name");
    expect(document.activeElement).toBe(input);
    const type = (text: string) => act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    type("Bad");
    key(input, "Enter");
    expect(submitted).toEqual(["Bad"]);
    expect(host.querySelector('[role="alert"]')!.textContent).toBe("That name is taken.");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    type("Good");
    expect(host.querySelector('[role="alert"]')).toBeNull();
    key(input, "Escape");
    expect(cancels).toHaveBeenCalledTimes(1);
  });
});
