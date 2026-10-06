import { describe, expect, it, vi } from "vitest";
import { desktopUserPresence } from "../desktop-user-presence";

describe("desktop lock and sleep presence", () => {
  it("withholds presence across screen lock and system sleep until both clear", () => {
    const listeners = new Map<string, () => void>();
    const emit = vi.fn();
    const power = { on: (event: string, fn: () => void) => { listeners.set(event, fn); },
      off: (event: string) => { listeners.delete(event); }, getSystemIdleState: () => "active" };
    const presence = desktopUserPresence(power, emit);
    expect(presence.available()).toBe(true);
    listeners.get("lock-screen")!(); expect(presence.available()).toBe(false);
    listeners.get("suspend")!(); listeners.get("unlock-screen")!(); expect(presence.available()).toBe(false);
    listeners.get("resume")!(); expect(presence.available()).toBe(true);
    expect(emit).toHaveBeenLastCalledWith("desktop-user-presence", { available: true });
    presence.close(); expect(listeners.size).toBe(0);
  });
  it("detects an already locked screen on first query", () => {
    const presence = desktopUserPresence({ on: vi.fn(), off: vi.fn(), getSystemIdleState: () => "locked" }, vi.fn());
    expect(presence.available()).toBe(false); presence.close();
  });
});
