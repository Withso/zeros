import { describe, expect, it, vi } from "vitest";

import {
  cleanupZsrRuntime,
  withZsrRuntimeCleanup,
} from "../zsr-runtime-cleanup.mjs";

describe("ZSR supervisor cleanup", () => {
  it("tears down initialized runtime state when post-wrap validation rejects", async () => {
    const calls: string[] = [];
    const state = {
      portPolicyControl: {
        close: vi.fn(async () => {
          calls.push("port-control");
        }),
      },
      sandboxManager: {
        cleanupAfterCommand: vi.fn(() => {
          calls.push("srt-cleanup");
        }),
        reset: vi.fn(async () => {
          calls.push("srt-reset");
        }),
      },
      cgroupScope: null as unknown,
      killCgroup: vi.fn(async () => {
        calls.push("cgroup");
      }),
    };

    await expect(
      withZsrRuntimeCleanup(state, async () => {
        calls.push("post-wrap-validation");
        throw new Error("sandbox wrapper retained a raw credential");
      }),
    ).rejects.toThrow("sandbox wrapper retained a raw credential");
    expect(calls).toEqual([
      "post-wrap-validation",
      "port-control",
      "srt-cleanup",
      "srt-reset",
      "cgroup",
    ]);
  });

  it("resets SRT and removes the cgroup when port-control cleanup fails", async () => {
    const calls: string[] = [];
    const portPolicyControl = {
      close: vi.fn(async () => {
        calls.push("port-control");
        throw new Error("private/path/policy.sock");
      }),
    };
    const sandboxManager = {
      cleanupAfterCommand: vi.fn(() => {
        calls.push("srt-cleanup");
      }),
      reset: vi.fn(async () => {
        calls.push("srt-reset");
      }),
    };
    const killCgroup = vi.fn(async () => {
      calls.push("cgroup");
    });

    await expect(
      cleanupZsrRuntime({
        portPolicyControl,
        sandboxManager,
        cgroupScope: { opaque: true },
        killCgroup,
      }),
    ).rejects.toThrow("sandbox runtime cleanup failed");
    expect(calls).toEqual([
      "port-control",
      "srt-cleanup",
      "srt-reset",
      "cgroup",
    ]);
    expect(portPolicyControl.close).toHaveBeenCalledOnce();
    expect(sandboxManager.reset).toHaveBeenCalledOnce();
    expect(killCgroup).toHaveBeenCalledOnce();
  });

  it("attempts reset and cgroup removal even when every earlier cleanup fails", async () => {
    const calls: string[] = [];
    await expect(
      cleanupZsrRuntime({
        portPolicyControl: {
          close: async () => {
            calls.push("port-control");
            throw new Error("close");
          },
        },
        sandboxManager: {
          cleanupAfterCommand() {
            calls.push("srt-cleanup");
            throw new Error("cleanup");
          },
          async reset() {
            calls.push("srt-reset");
            throw new Error("reset");
          },
        },
        cgroupScope: { opaque: true },
        async killCgroup() {
          calls.push("cgroup");
          throw new Error("kill");
        },
      }),
    ).rejects.toThrow("sandbox runtime cleanup failed");
    expect(calls).toEqual([
      "port-control",
      "srt-cleanup",
      "srt-reset",
      "cgroup",
    ]);
  });
});
