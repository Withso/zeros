import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const subscriptions = vi.hoisted(() => ({ changed: vi.fn(), cleanups: [] as Array<() => void> }));
vi.mock("react", () => ({ useSyncExternalStore: (subscribe: (changed: () => void) => () => void, snapshot: () => unknown) => {
  subscriptions.cleanups.push(subscribe(subscriptions.changed)); return snapshot();
} }));
import { useDocumentActive } from "../use-document-active";
let page: EventTarget & { visibilityState: string; hasFocus: () => boolean };
let focused: boolean;
beforeEach(() => {
  subscriptions.changed.mockClear(); focused = true;
  page = Object.assign(new EventTarget(), { visibilityState: "visible", hasFocus: () => focused });
  vi.stubGlobal("document", page); vi.stubGlobal("window", new EventTarget());
});
afterEach(() => { for (const cleanup of subscriptions.cleanups.splice(0)) cleanup(); vi.unstubAllGlobals(); });
function Fixture(active = true, foreground = false) { return useDocumentActive(active, foreground); }

describe("opt-in foreground observation", () => {
  it("reports blur and focus for opted-in Local observers", () => {
    expect(Fixture(true, true)).toBe(true);
    focused = false; window.dispatchEvent(new Event("blur"));
    expect(subscriptions.changed).toHaveBeenCalledOnce();
    expect(Fixture(true, true)).toBe(false);
  });
  it("keeps default visibility behavior and inactive observers unchanged", () => {
    focused = false;
    expect(Fixture()).toBe(true); expect(Fixture(false, true)).toBe(false);
    window.dispatchEvent(new Event("focus")); window.dispatchEvent(new Event("blur"));
    expect(subscriptions.changed).not.toHaveBeenCalled();
    page.visibilityState = "hidden"; page.dispatchEvent(new Event("visibilitychange"));
    expect(subscriptions.changed).toHaveBeenCalledOnce(); expect(Fixture()).toBe(false);
  });
  it("removes the actual document and window listeners on cleanup", () => {
    Fixture(true, true);
    for (const cleanup of subscriptions.cleanups.splice(0)) cleanup();
    window.dispatchEvent(new Event("focus")); window.dispatchEvent(new Event("blur")); page.dispatchEvent(new Event("visibilitychange"));
    expect(subscriptions.changed).not.toHaveBeenCalled();
  });
});
