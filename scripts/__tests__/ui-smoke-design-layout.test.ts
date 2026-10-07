import { describe, expect, it } from "vitest";

import { runDesignLayoutSmoke } from "../ui-smoke-design-layout.mjs";

describe("Design layout smoke synchronization", () => {
  it("waits for durable pin confirmation before resizing the parent fixture", async () => {
    const stop = new Error("Parent fixture resized after confirmation");
    let committed = false;
    let observedPendingPin = false;
    const parentStyle = new Proxy<Record<string, string>>(
      {},
      {
        set(target, property, value) {
          if (property === "width" && value === "600px") {
            expect(committed).toBe(true);
            throw stop;
          }
          return Reflect.set(target, property, value);
        },
      },
    );
    const node = {
      style: {} as Record<string, string>,
      parentElement: { style: parentStyle },
      click: () => {},
    };
    const locator = {
      locator: () => locator,
      getByRole: () => locator,
      getByLabel: () => locator,
      getByText: () => locator,
      click: async () => {},
      count: async () => 1,
      textContent: async () => "Right",
      inputValue: async () => "40",
      focus: async () => {},
      press: async () => {},
      fill: async () => {},
      isEnabled: async () => true,
      evaluate: async (callback: (element: typeof node) => unknown) =>
        callback(node),
    };
    const page = {
      url: () => "http://127.0.0.1:4100/harness.html",
      goto: async () => {},
      locator: () => locator,
      frameLocator: () => locator,
      // Authored frame/runtime readback confirms only the completed save.
      evaluate: async () => committed,
    };

    await expect(
      runDesignLayoutSmoke({
        page,
        check: () => {},
        waitFor: async (predicate: () => Promise<boolean>, label: string) => {
          if (label !== "layout-pin-committed") return true;
          // The inspector already says Right while the transaction is pending.
          expect(await predicate()).toBe(false);
          observedPendingPin = true;
          committed = true;
          expect(await predicate()).toBe(true);
          return true;
        },
      }),
    ).rejects.toBe(stop);

    expect(observedPendingPin).toBe(true);
  });
});
