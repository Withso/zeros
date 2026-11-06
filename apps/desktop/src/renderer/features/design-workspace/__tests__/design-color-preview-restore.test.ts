// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DesignColorField,
  DesignColorPanel,
  DesignColorPreviewScope,
  DesignColorValueInputs,
} from "../design-color-picker";

// check:ui ignore-next -- the fields edit literal colour values.
const [START, RED, GREEN] = ["#336699", "#ff0000", "#00ff00"];

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
});

function deferred() {
  let reject!: (error: unknown) => void;
  let resolve!: () => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function typeHex(label: string, text: string) {
  const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  await act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => input.blur());
}

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

describe("a color write that fails", () => {
  it("puts the canvas back after a typed hex is refused", async () => {
    const write = deferred();
    const onPreview = vi.fn(async () => {});
    const onCancelPreview = vi.fn();
    await act(async () =>
      root.render(
        createElement(DesignColorField, {
          value: START,
          label: "Fill",
          onPreview,
          onCancelPreview,
          onCommit: () => write.promise,
        }),
      ),
    );
    await typeHex("Fill", RED);
    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(onCancelPreview).not.toHaveBeenCalled();
    write.reject(new Error("Couldn't write"));
    await settle();
    expect(onCancelPreview).toHaveBeenCalledTimes(1);
  });

  it("waits for its own preview to finish before putting the canvas back", async () => {
    const painted = deferred();
    const onCancelPreview = vi.fn();
    await act(async () =>
      root.render(
        createElement(DesignColorField, {
          value: START,
          label: "Fill",
          onPreview: () => painted.promise,
          onCancelPreview,
          onCommit: () => Promise.reject(new Error("Couldn't write")),
        }),
      ),
    );
    await typeHex("Fill", RED);
    await settle();
    expect(onCancelPreview).not.toHaveBeenCalled();
    painted.resolve();
    await settle();
    expect(onCancelPreview).toHaveBeenCalledTimes(1);
  });

  it("leaves a newer write's color on the canvas", async () => {
    const first = deferred();
    const second = deferred();
    const writes = [first, second];
    const onCancelPreview = vi.fn();
    await act(async () =>
      root.render(
        createElement(DesignColorField, {
          value: START,
          label: "Fill",
          onPreview: async () => {},
          onCancelPreview,
          onCommit: () => writes.shift()!.promise,
        }),
      ),
    );
    await typeHex("Fill", RED);
    await typeHex("Fill", GREEN);
    first.reject(new Error("Couldn't write"));
    await settle();
    expect(onCancelPreview).not.toHaveBeenCalled();
    second.reject(new Error("Couldn't write"));
    await settle();
    expect(onCancelPreview).toHaveBeenCalledTimes(1);
  });

  it("leaves the picker's newer preview on the canvas", async () => {
    const typed = deferred();
    const onCancelPreview = vi.fn();
    const callbacks = { onPreview: async () => {}, onCancelPreview };
    await act(async () =>
      root.render(
        createElement(
          DesignColorPreviewScope,
          null,
          createElement(DesignColorValueInputs, {
            value: START,
            label: "Fill",
            ...callbacks,
            onCommit: () => typed.promise,
          }),
          createElement(DesignColorPanel, {
            value: START,
            label: "Picker",
            eyedropper: false,
            ...callbacks,
            onCommit: () => new Promise<void>(() => {}),
          }),
        ),
      ),
    );
    await typeHex("Fill", RED);
    const hue = host.querySelector<HTMLElement>('[aria-label="Picker hue"]')!;
    await act(async () => {
      hue.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    typed.reject(new Error("Couldn't write"));
    await settle();
    expect(onCancelPreview).not.toHaveBeenCalled();
  });

  it("puts the canvas back when the picker's own write is refused", async () => {
    const onCancelPreview = vi.fn();
    await act(async () =>
      root.render(
        createElement(DesignColorPanel, {
          value: START,
          label: "Picker",
          eyedropper: false,
          onPreview: async () => {},
          onCancelPreview,
          onCommit: () => Promise.reject(new Error("Couldn't write")),
        }),
      ),
    );
    const hue = host.querySelector<HTMLElement>('[aria-label="Picker hue"]')!;
    await act(async () => {
      hue.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    await settle();
    expect(onCancelPreview).toHaveBeenCalledTimes(1);
  });
});
