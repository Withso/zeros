import { describe, expect, it } from "vitest";

import {
  RESIZE_WIDTH_LOCK_SELECTOR,
  lockResizeDescendantWidths,
} from "../resize-layout-lock";

interface FakeStyle {
  values: Map<string, { value: string; priority: string }>;
  getPropertyValue(name: string): string;
  getPropertyPriority(name: string): string;
  setProperty(name: string, value: string, priority?: string): void;
  removeProperty(name: string): string;
}

function fakeStyle(
  initial?: { value: string; priority?: string },
): FakeStyle {
  const values = new Map<string, { value: string; priority: string }>();
  if (initial) {
    values.set("min-width", {
      value: initial.value,
      priority: initial.priority ?? "",
    });
  }
  return {
    values,
    getPropertyValue(name) {
      return values.get(name)?.value ?? "";
    },
    getPropertyPriority(name) {
      return values.get(name)?.priority ?? "";
    },
    setProperty(name, value, priority = "") {
      values.set(name, { value, priority });
    },
    removeProperty(name) {
      const previous = values.get(name)?.value ?? "";
      values.delete(name);
      return previous;
    },
  };
}

function fakeElement(
  width: number,
  events: string[],
  initialMinWidth?: { value: string; priority?: string },
) {
  const style = fakeStyle(initialMinWidth);
  return {
    style,
    getBoundingClientRect() {
      events.push(`read:${width}`);
      return { width };
    },
  };
}

describe("resize layout width lock", () => {
  it("sets a shrink floor without preventing surfaces from stretching wider", () => {
    const events: string[] = [];
    const first = fakeElement(640.25, events, {
      value: "72%",
      priority: "important",
    });
    const second = fakeElement(511, events);
    const elements = [first, second];
    for (const element of elements) {
      const originalSet = element.style.setProperty.bind(element.style);
      element.style.setProperty = (name, value, priority) => {
        events.push(`write:${name}:${value}`);
        originalSet(name, value, priority);
      };
    }
    const root = {
      querySelectorAll(selector: string) {
        expect(selector).toBe(RESIZE_WIDTH_LOCK_SELECTOR);
        return elements;
      },
    };

    const unlock = lockResizeDescendantWidths(root as unknown as ParentNode);

    expect(events).toEqual([
      "read:640.25",
      "read:511",
      "write:min-width:640.25px",
      "write:min-width:511px",
    ]);
    expect(first.style.values.get("min-width")).toEqual({
      value: "640.25px",
      priority: "",
    });
    expect(second.style.values.get("min-width")).toEqual({
      value: "511px",
      priority: "",
    });
    // Leaving `width` untouched lets normal stretch layout fill a widening
    // owner instead of exposing a frozen-width empty strip.
    expect(first.style.values.has("width")).toBe(false);
    expect(second.style.values.has("width")).toBe(false);

    unlock();
    expect(first.style.values.get("min-width")).toEqual({
      value: "72%",
      priority: "important",
    });
    expect(second.style.values.has("min-width")).toBe(false);

    // Cleanup can be reached through pointerup + lostpointercapture.
    unlock();
    expect(first.style.values.get("min-width")?.value).toBe("72%");
  });

  it("does not freeze disconnected or zero-width surfaces", () => {
    const events: string[] = [];
    const zero = fakeElement(0, events);
    const invalid = fakeElement(Number.NaN, events);
    const root = {
      querySelectorAll: () => [zero, invalid],
    };

    const unlock = lockResizeDescendantWidths(root as unknown as ParentNode);
    expect(zero.style.values.has("min-width")).toBe(false);
    expect(invalid.style.values.has("min-width")).toBe(false);
    unlock();
  });
});
