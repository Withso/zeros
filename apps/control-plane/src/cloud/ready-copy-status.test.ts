import { describe, expect, it } from "vitest";
import { readyCopyStatus } from "./ready-copy-status.js";
import type { CloudV2ReadyCopy } from "./ready-copies.js";

const now = new Date("2026-11-21T12:00:00Z"), day = 86_400_000;
const row = (generation: number, state: CloudV2ReadyCopy["state"], extra: Partial<CloudV2ReadyCopy> = {}) =>
  ({ generation, state, stale: false, stoppedAt: null, failureReason: null, failureDetail: null, ...extra }) as CloudV2ReadyCopy;
const retry = { failures: 2, nextAt: new Date(now.getTime() + 2 * 3_600_000), allowed: false };
const ready = row(1, "ready", { stoppedAt: new Date(now.getTime() - day) });

describe("ready copy status", () => {
  it.each([
    [[row(1, "building")], "getting_ready"], [[row(2, "building"), ready], "updating"], [[ready], "ready"],
    [[row(2, "failed", { failureReason: "ready_copy_setup_failed" }), ready], "update_failed"],
    [[row(1, "failed", { failureReason: "ready_copy_setup_failed" })], "failed"], [[], "none"],
    // The last good copy is past 13 days: it no longer serves.
    [[row(2, "failed"), row(1, "ready", { stoppedAt: new Date(now.getTime() - 14 * day) })], "failed"],
  ] as const)("reads %#", (history, state) => {
    expect(readyCopyStatus(history as unknown as CloudV2ReadyCopy[], retry, now, true).state).toBe(state);
  });

  it("tells admins the cause and next retry, and members never a failure", () => {
    const history = [row(2, "failed", { failureReason: "ready_copy_setup_failed", failureDetail: null }), ready];
    expect(readyCopyStatus(history, retry, now, true)).toMatchObject({ state: "update_failed",
      failure: { reason: "ready_copy_setup_failed", failures: 2, nextRetryAt: retry.nextAt.toISOString() } });
    expect(readyCopyStatus(history, retry, now, false)).toEqual({ state: "ready", updatedAt: ready.stoppedAt!.toISOString(),
      nextUpdateAt: new Date(ready.stoppedAt!.getTime() + 7 * day).toISOString() });
    expect(readyCopyStatus([history[0]!], { ...retry, nextAt: null }, now, false)).toEqual({ state: "none", updatedAt: null, nextUpdateAt: null });
    expect(readyCopyStatus([history[0]!], { ...retry, nextAt: null }, now, true).failure?.nextRetryAt).toBeNull();
  });
});
