import { afterEach, describe, expect, it, vi } from "vitest";

import {
  navigateMarketingPath,
  resolveMarketingPath,
  shouldHandleMarketingNavigation,
  subscribeToMarketingHistory,
} from "../marketing-route";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("marketing route resolution", () => {
  it.each([
    ["/", "home"],
    ["/changelog", "changelog"],
    ["/privacy", "privacy"],
    ["/terms", "terms"],
  ])("maps %s to %s", (pathname, route) => {
    expect(resolveMarketingPath(pathname)).toBe(route);
  });

  it("accepts trailing slashes and case variants", () => {
    expect(resolveMarketingPath("/CHANGELOG/")).toBe("changelog");
    expect(resolveMarketingPath("/privacy///")).toBe("privacy");
  });

  it("keeps unknown paths on the not-found surface", () => {
    expect(resolveMarketingPath("/unknown")).toBe("not-found");
    expect(resolveMarketingPath("//changelog")).toBe("not-found");
  });
});

describe("marketing browser navigation", () => {
  function installWindow(pathname = "/") {
    const target = new EventTarget() as EventTarget & {
      location: { pathname: string };
      history: { pushState: ReturnType<typeof vi.fn> };
    };
    target.location = { pathname };
    target.history = {
      pushState: vi.fn((_state, _unused, nextPath: string) => {
        target.location.pathname = nextPath;
      }),
    };
    class TestPopStateEvent extends Event {}
    vi.stubGlobal("window", target);
    vi.stubGlobal("PopStateEvent", TestPopStateEvent);
    return target;
  }

  it("publishes navigation through history and popstate", () => {
    const target = installWindow();
    const listener = vi.fn();
    const unsubscribe = subscribeToMarketingHistory(listener);

    navigateMarketingPath("/privacy");

    expect(target.history.pushState).toHaveBeenCalledWith(null, "", "/privacy");
    expect(listener).toHaveBeenCalledOnce();

    unsubscribe();
    target.dispatchEvent(new Event("popstate"));
    expect(listener).toHaveBeenCalledOnce();
  });

  it("does not republish an already-active path", () => {
    const target = installWindow("/terms");
    navigateMarketingPath("/terms");
    expect(target.history.pushState).not.toHaveBeenCalled();
  });

  it("preserves modified clicks and handles only a plain primary click", () => {
    const click = {
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
    };
    expect(shouldHandleMarketingNavigation(click)).toBe(true);
    expect(shouldHandleMarketingNavigation({ ...click, button: 1 })).toBe(
      false,
    );
    for (const key of ["metaKey", "ctrlKey", "shiftKey", "altKey"] as const) {
      expect(shouldHandleMarketingNavigation({ ...click, [key]: true })).toBe(
        false,
      );
    }
  });
});
