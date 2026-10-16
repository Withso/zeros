import { describe, expect, it, vi } from "vitest";

import {
  browserAppearanceMediaParams,
  createBrowserAppearanceController,
  type BrowserAppearanceDebugger,
} from "../browser/appearance";

/** One shared CDP session per page, like Electron's `webContents.debugger`:
 * any owner's detach ends the session for every owner and emits `detach`. */
function fakeDebugger() {
  let attached = false;
  const listeners = new Set<() => void>();
  const commands: Array<{ method: string; params: unknown }> = [];
  const debug = {
    isAttached: () => attached,
    attach: vi.fn((_protocolVersion?: string) => {
      if (attached) throw new Error("Debugger is already attached.");
      attached = true;
    }),
    detach: vi.fn(() => {
      if (!attached) return;
      attached = false;
      for (const listener of [...listeners]) listener();
    }),
    sendCommand: vi.fn(async (method: string, params?: object) => {
      if (!attached) throw new Error("Debugger is not attached.");
      commands.push({ method, params });
      return {};
    }),
    on: vi.fn((_event: "detach", listener: () => void) => {
      listeners.add(listener);
    }),
    off: vi.fn((_event: "detach", listener: () => void) => {
      listeners.delete(listener);
    }),
  };
  const contract: BrowserAppearanceDebugger = debug;
  return { debug, contract, commands, listeners };
}

function harness(alive = () => true) {
  const fake = fakeDebugger();
  const scheduled: Array<() => void> = [];
  const controller = createBrowserAppearanceController({
    debugger: fake.contract,
    isAlive: alive,
    schedule: (task) => scheduled.push(task),
  });
  const runScheduled = async () => {
    for (const task of scheduled.splice(0)) task();
    await Promise.resolve();
    await Promise.resolve();
  };
  return { ...fake, controller, runScheduled };
}

const dark = browserAppearanceMediaParams("dark");

describe("browser page appearance", () => {
  it("maps each choice to one prefers-color-scheme emulation", () => {
    expect(browserAppearanceMediaParams("dark")).toEqual({
      media: "",
      features: [{ name: "prefers-color-scheme", value: "dark" }],
    });
    expect(browserAppearanceMediaParams("light")).toEqual({
      media: "",
      features: [{ name: "prefers-color-scheme", value: "light" }],
    });
    // System clears the override so the page follows the Zeros appearance.
    expect(browserAppearanceMediaParams(null)).toEqual({
      media: "",
      features: [],
    });
  });

  it("never touches the debugger while the page follows the app", async () => {
    const { debug, controller } = harness();
    await controller.set(null);
    expect(debug.attach).not.toHaveBeenCalled();
    expect(debug.sendCommand).not.toHaveBeenCalled();
  });

  it("emulates the chosen scheme and keeps the session for later pages", async () => {
    const { debug, commands, controller } = harness();
    await controller.set("dark");
    expect(debug.attach).toHaveBeenCalledWith("1.3");
    expect(commands).toEqual([
      { method: "Emulation.setEmulatedMedia", params: dark },
    ]);
    // Chromium keeps the override across navigations while attached.
    expect(debug.isAttached()).toBe(true);
    expect(controller.appearance).toBe("dark");
    await controller.set("dark");
    expect(commands).toHaveLength(1);
  });

  it("shares a session another owner attached without taking it over", async () => {
    const { debug, commands, controller } = harness();
    debug.attach("1.3");
    debug.attach.mockClear();
    await controller.set("light");
    expect(debug.attach).not.toHaveBeenCalled();
    expect(commands.at(-1)?.params).toEqual(
      browserAppearanceMediaParams("light"),
    );
    await controller.set(null);
    expect(commands.at(-1)?.params).toEqual(browserAppearanceMediaParams(null));
    // Clearing never ends a session someone else may still be using.
    expect(debug.detach).not.toHaveBeenCalled();
  });

  it("reapplies the override after another owner ends the shared session", async () => {
    const { debug, commands, controller, runScheduled } = harness();
    await controller.set("dark");
    // Codex's built-in browser releases its debugger at the end of a turn,
    // which also wipes every emulation override on the page.
    debug.detach();
    expect(debug.isAttached()).toBe(false);
    await runScheduled();
    expect(debug.isAttached()).toBe(true);
    expect(commands).toEqual([
      { method: "Emulation.setEmulatedMedia", params: dark },
      { method: "Emulation.setEmulatedMedia", params: dark },
    ]);
  });

  it("uses the latest choice when a reapply runs after a change", async () => {
    const { debug, commands, controller, runScheduled } = harness();
    await controller.set("dark");
    debug.detach();
    await controller.set(null);
    await runScheduled();
    expect(debug.isAttached()).toBe(false);
    expect(commands).toHaveLength(1);
  });

  it("stops reapplying once disposed or when the page is gone", async () => {
    let alive = true;
    const first = harness(() => alive);
    await first.controller.set("dark");
    alive = false;
    first.debug.detach();
    await first.runScheduled();
    expect(first.debug.isAttached()).toBe(false);

    const second = harness();
    await second.controller.set("dark");
    second.controller.dispose();
    expect(second.listeners.size).toBe(0);
    second.debug.detach();
    await second.runScheduled();
    expect(second.debug.isAttached()).toBe(false);
    await second.controller.set("light");
    expect(second.debug.isAttached()).toBe(false);
  });

  it("reports a failed emulation instead of throwing and retries the same choice", async () => {
    const { debug, commands, controller } = harness();
    debug.sendCommand.mockRejectedValueOnce(new Error("Target closed."));
    await expect(controller.set("dark")).resolves.toBe(false);
    expect(commands).toHaveLength(0);
    await expect(controller.set("dark")).resolves.toBe(true);
    expect(commands).toEqual([
      { method: "Emulation.setEmulatedMedia", params: dark },
    ]);
    await expect(controller.set("light")).resolves.toBe(true);
  });
});
