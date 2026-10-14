import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PreparedBoundary, RepoTaskBoundaryFactory } from "../../agents/containment/types";
import {
  configureDesignStyleBuilds,
  designStyleBuildStatus,
  hasRunningDesignStyleBuilds,
  resetDesignStyleBuildsForTests,
  setDesignStyleBuildPresence,
  settleDesignStyleBuildRunsForTests,
  stopDesignStyleBuilds,
  type DesignStyleBuildSetting,
} from "../style-builds";

vi.mock("chokidar", () => ({
  watch: () => {
    const watcher = Object.assign(new EventEmitter(), { close: async () => {} });
    setImmediate(() => watcher.emit("ready"));
    return watcher;
  },
}));
vi.mock("../../agents/adapters/shared/login-shell-path", () => ({
  getLoginShellPath: async () => "/usr/bin:/bin",
}));

let root: string;
let proofFails: boolean;
let exitCode: number;
let processAlive: boolean;
const spawn = vi.fn();
const prove = vi.fn();
const setting: DesignStyleBuildSetting = {
  output: "dist/app.css", command: "fixture-build", timeoutSeconds: 120, watch: false, inputs: [],
};
const open = (settings = [setting]) => setDesignStyleBuildPresence(root, true, settings);
const leave = () => setDesignStyleBuildPresence(root, false, []);
const stop = () => stopDesignStyleBuilds((checkout) => checkout === root);

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "zeros-style-build-lifecycle-"));
  proofFails = false;
  exitCode = 0;
  processAlive = false;
  spawn.mockReset().mockImplementation(async () => {
    processAlive = true;
    return { wait: async () => ({ code: exitCode, signal: null }), stopAndProve: async () => {} };
  });
  prove.mockReset().mockImplementation(async () => {
    if (proofFails) throw new Error("boundary stop proof failed");
    processAlive = false;
  });
  const boundaryFactory: RepoTaskBoundaryFactory = async () => ({
    spawn, stopAndProve: prove,
  }) as unknown as PreparedBoundary;
  // Local and cloud both inject this same repository-boundary contract. The
  // shared scheduler must retain authority even after the command exits.
  configureDesignStyleBuilds({ boundaryFactory, changed: () => {}, idleMs: 60_000 });
});
afterEach(async () => {
  proofFails = false;
  await resetDesignStyleBuildsForTests();
  configureDesignStyleBuilds(null);
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

describe("style build containment authority", () => {
  it("rejects repeated archive attempts until the original boundary is proven stopped", async () => {
    proofFails = true;
    await open();
    await settleDesignStyleBuildRunsForTests();
    await expect(stop()).rejects.toThrow(/stop proof failed/);
    expect(processAlive).toBe(true);
    await expect(stop()).rejects.toThrow(/stop proof failed/);
    expect(hasRunningDesignStyleBuilds()).toBe(true);
    proofFails = false;
    await expect(stop()).resolves.toBeUndefined();
    expect(processAlive).toBe(false);
    expect(hasRunningDesignStyleBuilds()).toBe(false);
    expect(designStyleBuildStatus(root, setting.output)).toBeUndefined();
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("keeps the cloud engine busy after a command exits without stop proof", async () => {
    proofFails = true;
    await open();
    await settleDesignStyleBuildRunsForTests();
    expect(processAlive).toBe(true);
    expect(hasRunningDesignStyleBuilds()).toBe(true);
  });

  it.each(["remove", "replace"])("retains failed teardown when settings %s a build", async (action) => {
    proofFails = true;
    await open();
    await settleDesignStyleBuildRunsForTests();
    await expect(open(action === "remove" ? [] : [{ ...setting, command: "changed-build" }])).rejects.toThrow(/stop proof failed/);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(hasRunningDesignStyleBuilds()).toBe(true);
    await expect(stop()).rejects.toThrow(/stop proof failed/);
  });

  it("does not restart a watch command after its teardown failed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    proofFails = true;
    await open([{ ...setting, watch: true }]);
    await vi.waitFor(() => expect(designStyleBuildStatus(root, setting.output)?.state).toBe("failed"));
    await vi.advanceTimersByTimeAsync(40_000);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(hasRunningDesignStyleBuilds()).toBe(true);
  });

  it("retains failed idle teardown when old sessions are evicted", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    proofFails = true;
    await open();
    await settleDesignStyleBuildRunsForTests();
    await leave();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(designStyleBuildStatus(root, setting.output)?.state).toBe("failed");
    // Empty sessions fill the bounded view cache; none may evict the failed
    // teardown record belonging to another checkout.
    for (let index = 0; index < 65; index += 1) {
      await setDesignStyleBuildPresence(path.join(root, `other-${index}`), true, []);
    }
    await expect(stop()).rejects.toThrow(/stop proof failed/);
    expect(hasRunningDesignStyleBuilds()).toBe(true);
  });
});

describe("one-shot build recovery", () => {
  it("retries on reopening, but not on a presence heartbeat", async () => {
    exitCode = 1;
    await open();
    await settleDesignStyleBuildRunsForTests();
    expect(designStyleBuildStatus(root, setting.output)?.state).toBe("failed");
    await open();
    await settleDesignStyleBuildRunsForTests();
    expect(spawn).toHaveBeenCalledTimes(1);
    exitCode = 0;
    await leave();
    await open();
    await settleDesignStyleBuildRunsForTests();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(designStyleBuildStatus(root, setting.output)?.state).toBe("live");
  });
});
