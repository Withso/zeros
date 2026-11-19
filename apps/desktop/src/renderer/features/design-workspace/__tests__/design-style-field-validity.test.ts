// @vitest-environment jsdom
import { chromium, type Browser } from "@playwright/test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "../../../shared/ui/primitives";
import { DesignFieldOverlaysContext, type DesignFieldOverlaysApi } from "../design-field-overlays";
import { InspectorEditField } from "../design-inspector";
import { designAdvancedDeclarationSupport } from "../design-style-advanced";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });

interface FieldCase {
  label: string;
  property: string;
  value: string;
  /** Typed text and the value written for it. */
  valid: readonly (readonly [string, string])[];
  invalid: readonly string[];
}

// Every typed Style field goes through InspectorEditField with its property.
const FIELDS: readonly FieldCase[] = [
  {
    label: "Size", property: "font-size", value: "28px",
    valid: [["24", "24px"], ["1.5rem", "1.5rem"], ["120%", "120%"], ["inherit", "inherit"], ["larger", "larger"],
      ["var(--size)", "var(--size)"], ["calc(1rem + 2px)", "calc(1rem + 2px)"], ["clamp(12px, 2vw, 20px)", "clamp(12px, 2vw, 20px)"],
      ["min(10px, 2vw)", "min(10px, 2vw)"], ["max(10px, 2vw)", "max(10px, 2vw)"], ["1e3px", "1e3px"]],
    invalid: ["abc", "1e3", "5deg", "12pxx", "red"],
  },
  {
    label: "Line height", property: "line-height", value: "20px",
    valid: [["24", "24px"], ["normal", "normal"], ["1.5em", "1.5em"], ["var(--leading)", "var(--leading)"], ["calc(1em + 4px)", "calc(1em + 4px)"]],
    invalid: ["abc", "5deg", "red"],
  },
  {
    label: "Letter spacing", property: "letter-spacing", value: "0px",
    valid: [["2", "2px"], ["-1", "-1px"], ["0.02em", "0.02em"], ["normal", "normal"]],
    invalid: ["abc", "1e3", "5deg"],
  },
  {
    label: "Indent", property: "text-indent", value: "0px",
    valid: [["-8", "-8px"], ["2em", "2em"], ["10%", "10%"]],
    invalid: ["abc", "1e3"],
  },
  {
    label: "Stretch", property: "font-stretch", value: "100%",
    valid: [["75%", "75%"], ["condensed", "condensed"]],
    invalid: ["abc", "5px"],
  },
  {
    label: "Radius", property: "border-radius", value: "8px",
    valid: [["12", "12px"], ["50%", "50%"], ["4px 8px", "4px 8px"], ["var(--radius-md)", "var(--radius-md)"], ["inherit", "inherit"]],
    invalid: ["abc", "1e3", "red"],
  },
  {
    label: "Gap", property: "gap", value: "8px",
    valid: [["12", "12px"], ["1rem", "1rem"], ["normal", "normal"], ["calc(1rem + 2px)", "calc(1rem + 2px)"]],
    invalid: ["abc", "5deg"],
  },
  {
    label: "Top padding", property: "padding-top", value: "0px",
    valid: [["16", "16px"], ["5%", "5%"], ["max(8px, 2vw)", "max(8px, 2vw)"]],
    invalid: ["abc", "auto"],
  },
  {
    label: "Stroke weight", property: "border-top-width", value: "1px",
    valid: [["2", "2px"], ["thin", "thin"]],
    invalid: ["abc", "5%"],
  },
  {
    label: "Opacity", property: "opacity", value: "1",
    valid: [["0.5", "0.5"], ["50%", "50%"], ["var(--muted)", "var(--muted)"]],
    invalid: ["abc", "5px"],
  },
  {
    label: "Stacking order", property: "z-index", value: "auto",
    valid: [["3", "3"], ["-1", "-1"], ["inherit", "inherit"]],
    invalid: ["abc", "1.5"],
  },
  {
    label: "Duration", property: "transition-duration", value: "0s",
    valid: [["180", "180s"], ["200ms", "200ms"], ["var(--duration)", "var(--duration)"]],
    invalid: ["abc", "5px"],
  },
  {
    label: "Rotation", property: "rotate", value: "0deg",
    valid: [["45", "45deg"], ["0.25turn", "0.25turn"]],
    invalid: ["abc", "5px"],
  },
  {
    label: "Origin", property: "transform-origin", value: "50% 50%",
    valid: [["left top", "left top"], ["10px 20px", "10px 20px"]],
    invalid: ["abc"],
  },
  {
    label: "Width", property: "width", value: "240px",
    valid: [["12", "12px"], ["50%", "50%"], ["calc(100% - 20px)", "calc(100% - 20px)"], ["var(--width)", "var(--width)"], ["auto", "auto"]],
    invalid: ["abc", "5deg"],
  },
  {
    label: "Height", property: "height", value: "120px",
    valid: [["12", "12px"], ["40%", "40%"], ["calc(100vh - 20px)", "calc(100vh - 20px)"], ["var(--height)", "var(--height)"], ["auto", "auto"]],
    invalid: ["abc", "5deg"],
  },
  {
    label: "Word gap", property: "word-spacing", value: "0px",
    valid: [["2", "2px"], ["-1", "-1px"], ["normal", "normal"], ["0.02em", "0.02em"]],
    invalid: ["abc", "5deg"],
  },
  {
    label: "Horizontal padding", property: "padding-left", value: "0px",
    valid: [["16", "16px"], ["5%", "5%"], ["var(--pad)", "var(--pad)"]],
    invalid: ["abc", "auto"],
  },
  {
    label: "Horizontal margin", property: "margin-left", value: "0px",
    valid: [["-8", "-8px"], ["10%", "10%"], ["auto", "auto"], ["var(--margin)", "var(--margin)"]],
    invalid: ["abc", "5deg"],
  },
  {
    label: "Transition property", property: "transition-property", value: "all",
    valid: [["opacity", "opacity"], ["opacity, transform", "opacity, transform"], ["var(--motion-property)", "var(--motion-property)"], ["inherit", "inherit"]],
    invalid: ["10px", "5deg"],
  },
  {
    label: "Delay", property: "transition-delay", value: "0s",
    valid: [["120ms", "120ms"], ["-80ms", "-80ms"], ["var(--delay)", "var(--delay)"], ["calc(1s / 2)", "calc(1s / 2)"]],
    invalid: ["abc", "5px"],
  },
  {
    label: "Object", property: "object-position", value: "50% 50%",
    valid: [["left top", "left top"], ["10px 20px", "10px 20px"], ["center", "center"], ["var(--position)", "var(--position)"]],
    invalid: ["abc", "5deg"],
  },
  {
    label: "Offset", property: "outline-offset", value: "0px",
    valid: [["4", "4px"], ["-2", "-2px"], ["0.1em", "0.1em"], ["var(--offset)", "var(--offset)"]],
    invalid: ["abc", "5%"],
  },
];

// Which values a property takes is the browser's to say: ask Chromium once.
const answers = new Map<string, boolean>();
let browser: Browser | null = null;

beforeAll(async () => {
  const pairs: [string, string][] = [];
  for (const field of FIELDS) {
    for (const [typed, written] of field.valid) pairs.push([field.property, typed], [field.property, written]);
    for (const typed of field.invalid) pairs.push([field.property, typed], [field.property, `${typed}px`]);
  }
  pairs.push(["clip-path", "inherit"], ["clip-path", "circle(50%)"], ["clip-path", "12px"]);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const results = await page.evaluate((list) => list.map(([property, value]) => CSS.supports(property, value)), pairs);
  pairs.forEach(([property, value], index) => answers.set(`${property}\0${value}`, results[index]!));
  vi.stubGlobal("CSS", {
    escape: (value: string) => value,
    supports: (property: string, value: string) => {
      const answer = answers.get(`${property}\0${value}`);
      if (answer === undefined) throw new Error(`No browser answer for ${property}: ${value}`);
      return answer;
    },
  });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  vi.unstubAllGlobals();
});

let host: HTMLDivElement;
let root: Root | null = null;
const messages: { text: string; tone: string | undefined }[] = [];
const overlays: DesignFieldOverlaysApi = {
  openPicker: () => {},
  openPickerForField: () => false,
  resetField: () => {},
  fieldShortcut: () => {},
  showFieldMessage: (_field, text, tone) => messages.push({ text, tone }),
};

function mount(field: FieldCase, commits: string[]) {
  act(() => {
    root = createRoot(host);
    root.render(createElement(TooltipProvider, null,
      createElement(DesignFieldOverlaysContext.Provider, { value: overlays },
        createElement(InspectorEditField, {
          label: field.label,
          value: field.value,
          styleProperty: field.property,
          applied: true,
          onCommit: async (next: string) => { commits.push(next); },
        }))));
  });
  return host.querySelector<HTMLInputElement>("input")!;
}

async function typeAndEnter(input: HTMLInputElement, text: string) {
  act(() => input.focus());
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}

function unmount() {
  act(() => root?.unmount());
  root = null;
}

describe("a typed Style value", () => {
  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    messages.length = 0;
  });
  afterEach(() => {
    unmount();
    host.remove();
  });

  for (const field of FIELDS) {
    it(`${field.label} writes every value ${field.property} takes`, async () => {
      for (const [typed, written] of field.valid) {
        const commits: string[] = [];
        const input = mount(field, commits);
        await typeAndEnter(input, typed);
        expect(commits, `${field.label} ${typed}`).toEqual([written]);
        expect(messages, `${field.label} ${typed}`).toEqual([]);
        unmount();
      }
    });

    it(`${field.label} refuses what ${field.property} does not take, and keeps its value`, async () => {
      for (const typed of field.invalid) {
        const commits: string[] = [];
        const input = mount(field, commits);
        const shown = input.value;
        messages.length = 0;
        await typeAndEnter(input, typed);
        expect(commits, `${field.label} ${typed}`).toEqual([]);
        expect(input.value, `${field.label} ${typed}`).toBe(shown);
        expect(messages, `${field.label} ${typed}`).toEqual([
          { text: `${field.label} does not take ${typed}.${shown ? ` Kept ${shown}.` : ""}`, tone: "error" },
        ]);
        unmount();
      }
    });
  }

  it("checks More styles declarations against the browser and leaves custom properties open", () => {
    expect(designAdvancedDeclarationSupport("clip-path", "circle(50%)")).toEqual({ name: true, value: true });
    expect(designAdvancedDeclarationSupport("clip-path", "12px")).toEqual({ name: true, value: false });
    expect(designAdvancedDeclarationSupport("--card-art", "not a standard CSS value")).toEqual({ name: true, value: true });
  });

  it("still refuses a negative Size with its own reason", async () => {
    const commits: string[] = [];
    const input = mount(FIELDS[0]!, commits);
    await typeAndEnter(input, "-5");
    expect(commits).toEqual([]);
    expect(messages).toEqual([{ text: "Size cannot be negative. Kept 28.", tone: "error" }]);
  });
});
