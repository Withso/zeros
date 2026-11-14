import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startLocalCommandMaintenance } from "./maintenance.js";
import type { CloudLocalCommands } from "./requests.js";
import type { CloudLocalCommandSignals } from "./signals.js";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("keeps an empty device queue quiet for sixty seconds and still responds to a change", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  let notify = () => {}, due = false;
  const requests = { nextDue: vi.fn(async () => due ? 0 : null), sweep: vi.fn(async () => { due = false; return 0; }) };
  const signals = { start: vi.fn(async () => {}), subscribe: (listener: () => void) => { notify = listener; return () => {}; } };
  const stop = startLocalCommandMaintenance(requests as unknown as CloudLocalCommands, signals as unknown as CloudLocalCommandSignals);
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(requests.nextDue).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(requests.nextDue).toHaveBeenCalledOnce();
    expect(requests.sweep).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(requests.nextDue).toHaveBeenCalledTimes(2);
    due = true; notify();
    await vi.advanceTimersByTimeAsync(0);
    expect(requests.sweep).toHaveBeenCalledOnce();
  } finally { await stop(); }
});
