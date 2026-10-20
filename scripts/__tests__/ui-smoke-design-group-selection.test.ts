import { afterEach, describe, expect, it, vi } from "vitest";

import { shiftClickDesignGroupMember } from "../ui-smoke-design-group-selection.mjs";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

async function drainMicrotasks() {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

function fixture() {
  const save = deferred();
  const runtime = deferred();
  const overlay = {
    boundingBox: vi.fn(async () => ({ x: 20, y: 40, width: 100, height: 60 })),
  };
  const homeFrame = { locator: vi.fn(() => overlay) };
  const page = {
    evaluate: vi.fn(() => save.promise),
    waitForFunction: vi.fn(() => runtime.promise),
    keyboard: { down: vi.fn(async () => {}), up: vi.fn(async () => {}) },
    mouse: { click: vi.fn(async () => {}) },
  };
  const run = () => shiftClickDesignGroupMember({
    page, homeFrame, workspaceId: "workspace", frameFile: "home.html", nodeId: "copy",
  });
  return { page, overlay, homeFrame, save, runtime, run };
}

describe("Design group Shift-click smoke synchronization", () => {
  afterEach(() => vi.restoreAllMocks());

  it("waits for the preview's save and current runtime before pointer-down", async () => {
    const f = fixture();
    const result = f.run();
    await drainMicrotasks();
    expect(f.page.mouse.click).not.toHaveBeenCalled();
    expect(f.page.evaluate).toHaveBeenCalledOnce();
    f.save.resolve();
    await drainMicrotasks();
    expect(f.page.waitForFunction).toHaveBeenCalledOnce();
    expect(f.page.keyboard.down).not.toHaveBeenCalled();
    f.runtime.resolve();
    await result;
    expect(f.page.mouse.click).toHaveBeenCalledExactlyOnceWith(70, 70);
    expect(f.homeFrame.locator).toHaveBeenCalledWith('[data-design-element-overlay="copy"]');
    expect(f.page.keyboard.up).toHaveBeenCalledExactlyOnceWith("Shift");
  });

  it("spends one bounded readiness budget across the save and runtime", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const f = fixture();
    const result = f.run();
    await drainMicrotasks();
    now += 2_900;
    f.save.resolve();
    await drainMicrotasks();
    expect(f.page.waitForFunction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ workspaceId: "workspace", frameFile: "home.html", nodeId: "copy" }),
      { timeout: 2_100 },
    );
    f.runtime.resolve();
    await result;
  });

  it("does not send a click after save confirmation fails", async () => {
    const f = fixture();
    const failure = new Error("save confirmation unavailable");
    const result = f.run();
    const refused = expect(result).rejects.toBe(failure);
    f.save.reject(failure);
    await refused;
    expect(f.page.waitForFunction).not.toHaveBeenCalled();
    expect(f.page.keyboard.down).not.toHaveBeenCalled();
    expect(f.page.mouse.click).not.toHaveBeenCalled();
  });

  it("does not click a runtime that cannot confirm the saved source", async () => {
    const f = fixture();
    const failure = new Error("runtime readiness timed out");
    f.save.resolve();
    const result = f.run();
    const refused = expect(result).rejects.toBe(failure);
    await drainMicrotasks();
    f.runtime.reject(failure);
    await refused;
    expect(f.page.keyboard.down).not.toHaveBeenCalled();
    expect(f.page.mouse.click).not.toHaveBeenCalled();
  });

  it("releases Shift when the pointer action fails", async () => {
    const f = fixture();
    const failure = new Error("pointer action failed");
    f.save.resolve();
    f.runtime.resolve();
    f.page.mouse.click.mockRejectedValue(failure);
    await expect(f.run()).rejects.toBe(failure);
    expect(f.page.keyboard.up).toHaveBeenCalledExactlyOnceWith("Shift");
  });

  it("still refuses a selected member without canvas geometry", async () => {
    const f = fixture();
    f.save.resolve();
    f.runtime.resolve();
    f.overlay.boundingBox.mockResolvedValue(null as never);
    await expect(f.run()).rejects.toThrow("selected additive outline has no geometry");
    expect(f.page.keyboard.down).not.toHaveBeenCalled();
  });
});
