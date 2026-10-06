import { describe, expect, it, vi } from "vitest";
import { CloudWorkspaceInteraction } from "../cloud-workspace-interaction";
import type { CloudWorkspaceDocument } from "../../platform/cloud-workspaces";

function harness() {
  let now = 0, visible = true, focused = true, available = true;
  let current: { key: string; document: CloudWorkspaceDocument } | null = { key: "cloud://fixture", document: {
    status: "ready", generation: { number: 1 }, capabilities: { canWrite: true }, deletedAt: null, error: null,
  } as CloudWorkspaceDocument };
  const presence = vi.fn(() => true), wake = vi.fn(async (_key: string, _signal: AbortSignal) => {}), failed = vi.fn();
  const controller = new CloudWorkspaceInteraction({ now: () => now, current: () => current,
    visible: () => visible, focused: () => focused, available: () => available, presence, wake, failed });
  return { controller, wake, presence, failed, get current() { return current; }, set current(value) { current = value; },
    tick: (ms: number) => { now += ms; controller.refresh(); },
    visibility: (value: boolean) => { visible = value; controller.refresh(); },
    focus: (value: boolean) => { focused = value; controller.refresh(); },
    lock: () => { available = false; controller.refresh(); } };
}

describe("selected cloud workspace interaction", () => {
  it("sends immediate presence after input and once per minute for fifteen minutes", () => {
    const h = harness(); h.controller.refresh(); expect(h.presence).not.toHaveBeenCalled();
    h.controller.interact(); expect(h.presence).toHaveBeenLastCalledWith("cloud://fixture", true);
    for (let i = 0; i < 200; i++) h.controller.interact();
    expect(h.presence).toHaveBeenCalledOnce();
    h.tick(60_000); expect(h.presence).toHaveBeenCalledTimes(2);
    h.tick(14 * 60_000); expect(h.presence).toHaveBeenLastCalledWith("cloud://fixture", false);
    expect(h.wake).not.toHaveBeenCalled();
  });

  it.each(["hide", "blur", "lock"])("withdraws presence on %s and does not wake on resume", kind => {
    const h = harness(); h.controller.interact();
    if (kind === "hide") h.visibility(false);
    if (kind === "blur") h.focus(false);
    if (kind === "lock") h.lock();
    expect(h.presence).toHaveBeenLastCalledWith("cloud://fixture", false);
    h.current!.document.status = "stopped"; h.visibility(true); h.focus(true); h.tick(60_000);
    expect(h.wake).not.toHaveBeenCalled();
  });

  it("wakes once for app input during sleep, shares the pending flight, and never wakes for refresh", async () => {
    const h = harness(); h.current!.document.status = "stopped";
    let done!: () => void; h.wake.mockImplementation(() => new Promise(resolve => { done = resolve; }));
    h.controller.refresh(); h.tick(600_000); expect(h.wake).not.toHaveBeenCalled();
    for (let i = 0; i < 200; i++) h.controller.interact();
    expect(h.wake).toHaveBeenCalledOnce(); expect(h.presence).not.toHaveBeenCalled();
    h.current!.document.status = "ready"; done(); await Promise.resolve();
    h.controller.refresh(); expect(h.presence).toHaveBeenLastCalledWith("cloud://fixture", true);
  });

  it.each(["stopping", "waking", "setting_up"])("uses the existing wake path once while %s", status => {
    const h = harness(); h.current!.document.status = status;
    h.controller.interact(); expect(h.wake).toHaveBeenCalledOnce();
  });

  it.each(["archived", "deleting", "deleted", "viewer", "local", "other-row", "hidden"])("does not wake %s", reason => {
    const h = harness(); h.current!.document.status = "stopped";
    if (["archived", "deleting", "deleted"].includes(reason)) h.current!.document.status = reason;
    if (reason === "viewer") h.current!.document.capabilities.canWrite = false;
    if (reason === "local") h.current = null;
    if (reason === "hidden") h.visibility(false);
    h.controller.interact(reason === "other-row"); expect(h.wake).not.toHaveBeenCalled();
  });

  it("allows prompters to wake, and limits an incident to one automatic attempt per five minutes", async () => {
    const h = harness(); h.current!.document.status = "stopped";
    h.current!.document.error = { code: "cloud_workspace_safety_failure", message: "Safety check failed" };
    h.controller.interact(); await Promise.resolve(); await Promise.resolve();
    h.current!.document.generation.number++;
    h.tick(60_000); h.controller.interact(); expect(h.wake).toHaveBeenCalledOnce();
    h.tick(4 * 60_000); h.controller.interact(); expect(h.wake).toHaveBeenCalledTimes(2);
  });

  it("releases the old exact workspace on selection changes and ignores a stale wake result", async () => {
    const h = harness(); h.controller.interact();
    h.current = null; h.controller.refresh();
    expect(h.presence).toHaveBeenLastCalledWith("cloud://fixture", false);
    h.controller.close(); h.tick(60_000); h.controller.interact(); expect(h.wake).not.toHaveBeenCalled();
  });

  it("aborts only the old selected wake and ignores its later failure", async () => {
    const h = harness(); h.current!.document.status = "stopped";
    let reject!: (error: Error) => void;
    h.wake.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    h.controller.interact(); const signal = h.wake.mock.calls[0][1];
    h.current = null; h.controller.refresh(); expect(signal.aborted).toBe(true);
    reject(new Error("Old workspace admission failed")); await Promise.resolve(); await Promise.resolve();
    h.controller.interact(); expect(h.wake).toHaveBeenCalledOnce(); expect(h.presence).not.toHaveBeenCalled(); expect(h.failed).not.toHaveBeenCalled();
  });

  it("wakes after a committed idle stop races with input on a still-ready catalog snapshot", () => {
    const h = harness(); h.controller.interact(); expect(h.wake).not.toHaveBeenCalled();
    h.current!.document.status = "stopping"; h.controller.refresh(); expect(h.wake).toHaveBeenCalledOnce();
    h.current!.document.status = "stopped"; h.controller.refresh(); expect(h.wake).toHaveBeenCalledOnce();
  });

  it("retains the gesture across a delayed stop publication beyond the regular catalog interval", () => {
    const h = harness(); h.controller.interact();
    h.tick(45_000); h.current!.document.status = "stopping"; h.controller.refresh();
    expect(h.wake).toHaveBeenCalledOnce();
  });

  it("expires an unconsumed gesture after two minutes without waking for a later passive refresh", () => {
    const h = harness(); h.controller.interact();
    h.tick(120_000); h.current!.document.status = "stopped"; h.controller.refresh();
    expect(h.wake).not.toHaveBeenCalled();
  });
});
