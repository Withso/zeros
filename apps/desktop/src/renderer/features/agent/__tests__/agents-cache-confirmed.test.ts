// Regression: a FAILED registry load is indistinguishable from an authoritative
// empty one once `runLoad` publishes its `[]` fallback. Auto-bind treats the
// snapshot as final and stops recording a provisional binding, so a chat opened
// during a startup blip stays pinned to the product fallback ("codex") forever —
// even on a machine where only Claude or Cursor is installed. The cache has to
// say whether the list it is publishing was ever actually confirmed.

import { describe, expect, it } from "vitest";

import type { BridgeRegistryAgent } from "../../../platform/bridge/messages";
import {
  getAgentsSnapshot,
  hasConfirmedAgents,
  loadAgents,
} from "../agents-cache";

const agent = (id: string): BridgeRegistryAgent =>
  ({ id, name: id, authenticated: true }) as unknown as BridgeRegistryAgent;

describe("agents cache — confirmed vs guessed snapshots", () => {
  it("stays unconfirmed through a failed load, then confirms on success", async () => {
    // Cold module: nothing on disk (no localStorage in this env), nothing read.
    expect(getAgentsSnapshot()).toBeNull();
    expect(hasConfirmedAgents()).toBe(false);

    await expect(
      loadAgents(() => Promise.reject(new Error("engine unreachable"))),
    ).rejects.toThrow("engine unreachable");

    // The published `[]` keeps every reader rendering, but it is a fallback,
    // not an answer — callers that bind identity off it must know that.
    expect(getAgentsSnapshot()).toEqual([]);
    expect(hasConfirmedAgents()).toBe(false);

    await loadAgents(() => Promise.resolve([agent("claude")]));

    expect(getAgentsSnapshot()).toEqual([agent("claude")]);
    expect(hasConfirmedAgents()).toBe(true);
  });

  it("keeps the confirmation across an explicit invalidate", async () => {
    const { invalidateAgentsCache } = await import("../agents-cache");
    invalidateAgentsCache();

    // Forcing the next read to hit the engine does not un-answer the last one;
    // treating it as unconfirmed would re-provision every already-bound chat.
    expect(hasConfirmedAgents()).toBe(true);
  });
});
