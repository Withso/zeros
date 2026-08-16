import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createNativeSurfaceOverlayIntent,
  listenForNativeSurfaceOverlayIntent,
  publishNativeSurfaceOverlayIntent,
} from "../../native-surface-overlay";

describe("native surface overlay intent", () => {
  const originalDocument = globalThis.document;
  const originalCustomEvent = globalThis.CustomEvent;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalDocument) vi.stubGlobal("document", originalDocument);
    if (originalCustomEvent) vi.stubGlobal("CustomEvent", originalCustomEvent);
  });

  it("announces an overlay before its renderer portal mounts", () => {
    const target = new EventTarget();
    class TestCustomEvent<T> extends Event {
      detail: T;

      constructor(type: string, init: CustomEventInit<T>) {
        super(type);
        this.detail = init.detail as T;
      }
    }
    vi.stubGlobal("document", target);
    vi.stubGlobal("CustomEvent", TestCustomEvent);
    const listener = vi.fn();
    const dispose = listenForNativeSurfaceOverlayIntent(listener);

    publishNativeSurfaceOverlayIntent(true);
    publishNativeSurfaceOverlayIntent(false);
    dispose();
    publishNativeSurfaceOverlayIntent(true);

    expect(listener.mock.calls).toEqual([[true], [false]]);
    publishNativeSurfaceOverlayIntent(false);
  });

  it("keeps the native surface parked until every overlapping overlay closes", () => {
    const target = new EventTarget();
    class TestCustomEvent<T> extends Event {
      detail: T;

      constructor(type: string, init: CustomEventInit<T>) {
        super(type);
        this.detail = init.detail as T;
      }
    }
    vi.stubGlobal("document", target);
    vi.stubGlobal("CustomEvent", TestCustomEvent);
    const listener = vi.fn();
    listenForNativeSurfaceOverlayIntent(listener);
    const menu = createNativeSurfaceOverlayIntent();
    const tooltip = createNativeSurfaceOverlayIntent();

    menu(true);
    tooltip(true);
    menu(false);
    tooltip(false);

    expect(listener.mock.calls).toEqual([[true], [false]]);
  });
});
