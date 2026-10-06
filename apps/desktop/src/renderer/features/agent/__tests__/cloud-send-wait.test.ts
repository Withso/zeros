import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudSendWait, CloudSendWaitError } from "../cloud-send-wait";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
function harness() {
  const wait = new CloudSendWait(), ready = vi.fn(), failed = vi.fn(), cancel = vi.fn();
  const options = { current: () => true, attempt: vi.fn(async (_signal: AbortSignal) => false), terminal: (error: unknown) => error instanceof CloudSendWaitError,
    ready, failed, cancelPreparation: cancel };
  return { wait, options, ready, failed, cancel };
}
describe("cloud queue readiness wait", () => {
  it("shares readiness across queued messages, tolerates reconnects and dispatches only once when ready", async () => {
    const h = harness(); h.options.attempt.mockRejectedValueOnce(new Error("Connection retired"))
      .mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    h.wait.start("chat", h.options); h.wait.start("chat", h.options);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(h.options.attempt).toHaveBeenCalledTimes(3); expect(h.ready).toHaveBeenCalledOnce(); expect(h.failed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(180_000); expect(h.ready).toHaveBeenCalledOnce();
  });
  it("bounds a hung wake or initialization at three minutes and fences late readiness", async () => {
    const h = harness(); let finish!: (ready: boolean) => void;
    h.options.attempt.mockReturnValue(new Promise(resolve => { finish = resolve; })); h.wait.start("chat", h.options);
    await vi.advanceTimersByTimeAsync(179_999); expect(h.failed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(h.failed).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("three minutes") }));
    expect(h.cancel).toHaveBeenCalledOnce(); finish(true); await vi.advanceTimersByTimeAsync(0); expect(h.ready).not.toHaveBeenCalled();
    h.options.attempt.mockResolvedValue(true); h.wait.start("chat", h.options); await vi.advanceTimersByTimeAsync(0);
    expect(h.ready).toHaveBeenCalledOnce();
  });
  it("keeps removal and a replacement wait independent of the cancelled completion", async () => {
    const h = harness(); let old!: (ready: boolean) => void;
    h.options.attempt.mockReturnValueOnce(new Promise(resolve => { old = resolve; })).mockResolvedValue(true);
    h.wait.start("chat", h.options); h.wait.cancel("chat"); h.wait.start("chat", h.options);
    old(true); await vi.advanceTimersByTimeAsync(0); expect(h.ready).toHaveBeenCalledOnce(); expect(h.failed).not.toHaveBeenCalled();
    expect(h.options.attempt.mock.calls[0]![0].aborted).toBe(true);
  });
  it("shows a terminal cause inline immediately and never retries it", async () => {
    const h = harness(); h.options.attempt.mockRejectedValue(new CloudSendWaitError("Connect this agent to continue."));
    h.wait.start("chat", h.options); await vi.advanceTimersByTimeAsync(180_000);
    expect(h.failed).toHaveBeenCalledOnce(); expect(h.options.attempt).toHaveBeenCalledOnce(); expect(h.ready).not.toHaveBeenCalled();
  });
  it("does not redirect queued work after its owner changes", async () => {
    const h = harness(); let current = true;
    h.options.current = () => current; h.wait.start("chat", h.options); current = false;
    await vi.advanceTimersByTimeAsync(180_000); expect(h.ready).not.toHaveBeenCalled(); expect(h.failed).not.toHaveBeenCalled();
  });
  it("uses elapsed timers rather than a device wall clock and isolates chats", async () => {
    const h = harness(); h.wait.start("chat", h.options);
    vi.setSystemTime(Date.now() + 86_400_000); await vi.advanceTimersByTimeAsync(2_000); expect(h.failed).not.toHaveBeenCalled();
    const sibling = { ...h.options, attempt: vi.fn(async () => true), ready: vi.fn() };
    h.wait.start("other", sibling); await vi.advanceTimersByTimeAsync(0); expect(sibling.ready).toHaveBeenCalledOnce();
    h.wait.clear(); await vi.advanceTimersByTimeAsync(180_000); expect(h.failed).not.toHaveBeenCalled();
  });
});
