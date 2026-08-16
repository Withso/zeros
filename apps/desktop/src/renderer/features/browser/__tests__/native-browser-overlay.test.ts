import { describe, expect, it, vi } from "vitest";

import {
  NativeBrowserSurfaceCommandQueue,
  NATIVE_BROWSER_BLOCKING_OVERLAY_SELECTOR,
  hasOpenNativeBrowserBlockingOverlay,
  nativeBrowserOverlayShouldParkSurface,
  requestImmediateNativeBrowserSurfacePark,
} from "../native-browser-overlay";

describe("native browser overlay suppression", () => {
  it("parks the native guest while any trusted app overlay is visible", () => {
    const querySelector = vi.fn(() => ({ role: "dialog" }));
    expect(hasOpenNativeBrowserBlockingOverlay({ querySelector })).toBe(true);
    expect(querySelector).toHaveBeenCalledWith(
      NATIVE_BROWSER_BLOCKING_OVERLAY_SELECTOR,
    );
    expect(NATIVE_BROWSER_BLOCKING_OVERLAY_SELECTOR).toContain(
      '[role="alertdialog"]',
    );
    expect(NATIVE_BROWSER_BLOCKING_OVERLAY_SELECTOR).toContain(
      '[data-zeros-native-overlay="popover"][data-state="open"]',
    );
    expect(NATIVE_BROWSER_BLOCKING_OVERLAY_SELECTOR).toContain(
      "[data-sonner-toast]",
    );
    expect(NATIVE_BROWSER_BLOCKING_OVERLAY_SELECTOR).toContain(
      '[role="tooltip"]',
    );
    expect(NATIVE_BROWSER_BLOCKING_OVERLAY_SELECTOR).toContain(
      '[data-slot="sheet-content"][data-state="open"]',
    );
  });

  it("keeps the live guest attached when no blocking overlay exists", () => {
    expect(
      hasOpenNativeBrowserBlockingOverlay({ querySelector: () => null }),
    ).toBe(false);
  });

  it("parks from a retained capture before a menu or tooltip paints", () => {
    expect(
      nativeBrowserOverlayShouldParkSurface({
        overlayOpen: true,
      }),
    ).toBe(true);
    expect(
      nativeBrowserOverlayShouldParkSurface({
        overlayOpen: true,
      }),
    ).toBe(true);
    expect(
      nativeBrowserOverlayShouldParkSurface({
        overlayOpen: false,
      }),
    ).toBe(false);
    expect(nativeBrowserOverlayShouldParkSurface({ overlayOpen: true })).toBe(
      true,
    );
  });

  it("requests native parking synchronously in the overlay-open event stack", () => {
    const order: string[] = [];
    const requested = requestImmediateNativeBrowserSurfacePark(
      {
        overlayOpening: true,
        browserSessionId: "browser-overlay-timing",
        surfaceId: "workbench:browser-tab",
      },
      (request) => {
        order.push(
          `${request.browserSessionId}:${request.surfaceId}:park-requested`,
        );
        return true;
      },
    );
    order.push("portal-mount");

    expect(requested).toBe(true);
    expect(order).toEqual([
      "browser-overlay-timing:workbench:browser-tab:park-requested",
      "portal-mount",
    ]);
    expect(
      requestImmediateNativeBrowserSurfacePark(
        {
          overlayOpening: false,
          browserSessionId: "browser-overlay-timing",
          surfaceId: "workbench:browser-tab",
        },
        vi.fn(),
      ),
    ).toBe(false);
  });

  it("serializes attach and detach commands across React effect replacements", async () => {
    const queue = new NativeBrowserSurfaceCommandQueue();
    const order: string[] = [];
    let finishAttach!: () => void;
    const attached = queue.enqueue(
      () =>
        new Promise<void>((resolve) => {
          order.push("attach:start");
          finishAttach = () => {
            order.push("attach:end");
            resolve();
          };
        }),
    );
    const detached = queue.enqueue(async () => {
      order.push("detach");
    });
    const reattached = queue.enqueue(async () => {
      order.push("reattach");
    });

    await Promise.resolve();
    expect(order).toEqual(["attach:start"]);
    finishAttach();
    await Promise.all([attached, detached, reattached]);
    expect(order).toEqual(["attach:start", "attach:end", "detach", "reattach"]);
  });
});
