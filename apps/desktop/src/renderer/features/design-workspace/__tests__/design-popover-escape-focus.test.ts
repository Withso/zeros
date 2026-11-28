// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  TooltipProvider,
} from "../../../shared/ui/primitives";
import { DesignFieldOverlaysContext, type DesignFieldOverlaysApi } from "../design-field-overlays";
import { InspectorEditField } from "../design-inspector";
import { keepDesignPopoverWhileEditing } from "../design-inspector-kit";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });

const overlays: DesignFieldOverlaysApi = {
  openPicker: () => {},
  openPickerForField: () => false,
  resetField: () => {},
  fieldShortcut: () => {},
  showFieldMessage: () => {},
};

let host: HTMLDivElement;
let root: Root | null = null;

async function flush() {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

it("Escape in a dirty popover field reverts, closes, focuses the trigger, then lets the next Escape reach canvas scope", async () => {
  act(() => {
    root = createRoot(host);
    root.render(createElement(TooltipProvider, null,
      createElement(DesignFieldOverlaysContext.Provider, { value: overlays },
        createElement(Popover, null,
          createElement(PopoverTrigger, { asChild: true },
            createElement("button", { type: "button", "aria-label": "Type settings" }, "settings")),
          createElement(PopoverContent, {
            ...({ "data-design-popover": "" } as Record<string, string>),
            onEscapeKeyDown: keepDesignPopoverWhileEditing,
          }, createElement(InspectorEditField, {
            label: "Indent",
            value: "0px",
            styleProperty: "text-indent",
            onCommit: async () => {},
          }))))));
  });
  const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="Type settings"]')!;
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Indent"]');
  expect(input).not.toBeNull();
  act(() => input!.focus());
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input!, "9");
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  await flush();
  expect(input!.isConnected).toBe(false);
  expect(document.querySelector("[data-design-popover]")).toBeNull();
  expect(document.activeElement).toBe(trigger);

  const seen: string[] = [];
  const canvasScopeListener = (event: KeyboardEvent) => seen.push(event.key);
  window.addEventListener("keydown", canvasScopeListener);
  trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  window.removeEventListener("keydown", canvasScopeListener);
  expect(seen).toEqual(["Escape"]);
});
