import { afterEach, expect, it, vi } from "vitest";
import { PromptInbox } from "../prompt-inbox";
import type { Agents } from "../agents";
import type { SessionStore } from "../sessions/session-store";

afterEach(() => vi.useRealTimers());

it("measures the legacy idle inbox cadence without an app or activity", async () => {
  vi.useFakeTimers();
  const requests: Array<{ waitMs: number }> = [];
  const store = { onChange: () => () => {}, outboxEntries: () => [] } as unknown as SessionStore;
  const agents = { setOutboxDispatch: () => {} } as unknown as Agents;
  const inbox = new PromptInbox(store, agents, async (operation, raw, signal) => {
    if (operation !== "pull") throw new Error("Unexpected idle operation");
    const body = raw as { waitMs: number }; requests.push(body);
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(new Error("Cancelled")); };
      const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, body.waitMs || 250);
      signal?.addEventListener("abort", abort, { once: true });
    });
    return { prompts: [], stops: [] };
  });
  inbox.start();
  try {
    await vi.advanceTimersByTimeAsync(250);
    requests.length = 0;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    console.info("Idle prompt polls per five minutes", requests.length);
    expect(requests).toHaveLength(12);
    expect(requests.every(body => body.waitMs === 25_000)).toBe(true);
    expect(inbox.runtimeBusy).toBe(false);
  } finally { await inbox.dispose(); }
});
