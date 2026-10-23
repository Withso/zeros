import { afterEach, expect, it, vi } from "vitest";
import { CloudV2PromptSignals } from "./prompt-signals.js";
afterEach(() => vi.useRealTimers());

it("bounds waiters and releases every slot on hint, timeout, abort and shutdown", async () => {
  vi.useFakeTimers();
  const signals = new CloudV2PromptSignals(), controller = new AbortController();
  const waiters = Array.from({ length: 8 }, () => signals.wait("workspace", 25_000, controller.signal));
  expect(() => signals.wait("workspace", 25_000, controller.signal)).toThrow("Too many delivery polls");
  signals.wake("workspace"); await Promise.all(waiters.map(waiter => waiter.wait));
  const afterHint = signals.wait("workspace", 25_000, controller.signal); controller.abort(); await afterHint.wait;
  const afterAbort = signals.wait("workspace", 25_000, new AbortController().signal);
  await vi.advanceTimersByTimeAsync(25_000); await afterAbort.wait;
  const shutdown = signals.wait("workspace", 25_000, new AbortController().signal); signals.wakeAll(); await shutdown.wait;
  const next = signals.wait("workspace", 25_000, new AbortController().signal); next.dispose(); next.dispose(); await next.wait;
});
