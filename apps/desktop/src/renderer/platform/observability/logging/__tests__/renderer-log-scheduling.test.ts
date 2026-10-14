import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetRendererLogForTests,
  initRendererLogCapture,
  logEvent,
  type RendererLogRecord,
} from "../renderer-log";

const { nativeInvoke, isElectron } = vi.hoisted(() => ({
  nativeInvoke: vi.fn(),
  isElectron: vi.fn(),
}));

vi.mock("@/renderer/platform/runtime", () => ({ nativeInvoke, isElectron }));

const START = Date.parse("2026-01-01T00:00:00Z");

async function installAndDrain(): Promise<void> {
  initRendererLogCapture();
  await vi.advanceTimersByTimeAsync(1_000);
  nativeInvoke.mockClear();
}

function submittedRecords(): RendererLogRecord[] {
  return nativeInvoke.mock.calls.flatMap(([, payload]) => payload.records);
}

describe("renderer log scheduling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    vi.stubGlobal("window", new EventTarget());
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation(() => {});
    }
    _resetRendererLogForTests();
    nativeInvoke.mockReset().mockResolvedValue(undefined);
    isElectron.mockReturnValue(true);
  });

  afterEach(() => {
    _resetRendererLogForTests();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("has no scheduled work after the initial record drains", async () => {
    initRendererLogCapture();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(nativeInvoke).toHaveBeenCalledOnce();
    expect(submittedRecords().map((record) => record.text)).toEqual([
      "renderer log capture installed",
    ]);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(nativeInvoke).toHaveBeenCalledOnce();
  });

  it("batches new records within one second without extending the first record's wait", async () => {
    await installAndDrain();
    logEvent("first");
    await vi.advanceTimersByTimeAsync(400);
    logEvent("second");
    await vi.advanceTimersByTimeAsync(599);
    expect(nativeInvoke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(nativeInvoke).toHaveBeenCalledOnce();
    expect(submittedRecords().map((record) => record.text)).toEqual(["first", "second"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("flushes a full threshold batch immediately and cancels the pending timer", async () => {
    await installAndDrain();
    for (let i = 0; i < 100; i++) logEvent(`record ${i}`);
    await vi.advanceTimersByTimeAsync(0);
    expect(nativeInvoke).toHaveBeenCalledOnce();
    expect(submittedRecords()).toHaveLength(100);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(nativeInvoke).toHaveBeenCalledOnce();
  });

  it("retains mixed Local and cloud diagnostics during pending IPC without polling or overlap", async () => {
    await installAndDrain();
    let finish!: () => void;
    nativeInvoke.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    logEvent("Local Personal activity");
    await vi.advanceTimersByTimeAsync(1_000);
    try {
      logEvent("organization-local activity");
      logEvent("organization-cloud activity");
      logEvent("Local Personal activity resumed");
      window.dispatchEvent(new Event("pagehide"));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(nativeInvoke).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      finish();
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(nativeInvoke.mock.calls.map(([command]) => command)).toEqual(["log_submit", "log_submit"]);
    expect(submittedRecords().map((record) => record.text)).toEqual([
      "Local Personal activity",
      "organization-local activity",
      "organization-cloud activity",
      "Local Personal activity resumed",
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("parks queued records until the circuit deadline with no intermediate timer wake", async () => {
    nativeInvoke.mockRejectedValue(new Error("IPC unavailable"));
    initRendererLogCapture();
    await vi.advanceTimersByTimeAsync(1_000);
    logEvent("second attempt");
    await vi.advanceTimersByTimeAsync(1_000);
    logEvent("third attempt");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(nativeInvoke).toHaveBeenCalledTimes(3);
    nativeInvoke.mockResolvedValue(undefined);
    logEvent("recovery probe");
    window.dispatchEvent(new Event("pagehide"));
    expect(nativeInvoke).toHaveBeenCalledTimes(3);
    await vi.advanceTimersToNextTimerAsync();
    expect(Date.now()).toBe(START + 5_000);
    expect(nativeInvoke).toHaveBeenCalledTimes(4);
    expect(submittedRecords().at(-1)?.text).toBe("recovery probe");
    expect(vi.getTimerCount()).toBe(0);
    logEvent("normal cadence restored");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(nativeInvoke).toHaveBeenCalledTimes(5);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not schedule circuit probes when no records remain after failure", async () => {
    nativeInvoke.mockRejectedValue(new Error("IPC unavailable"));
    initRendererLogCapture();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(nativeInvoke).toHaveBeenCalledOnce();
  });

  it("keeps the bounded queue, batch limit and overflow notice while IPC is stalled", async () => {
    await installAndDrain();
    let finish!: () => void;
    nativeInvoke.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    logEvent("in flight");
    await vi.advanceTimersByTimeAsync(1_000);
    try {
      for (let i = 0; i < 2_500; i++) logEvent(`queued ${i}`);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(nativeInvoke).toHaveBeenCalledOnce();
    } finally {
      finish();
      await vi.advanceTimersByTimeAsync(6_000);
    }
    const records = submittedRecords();
    expect(records.filter((record) => record.text.startsWith("queued ")).map((record) => record.text))
      .toEqual(Array.from({ length: 2_000 }, (_, i) => `queued ${i + 500}`));
    expect(records.filter((record) => record.tags?.includes("log-store"))).toEqual([
      expect.objectContaining({ level: "warn", text: "renderer log queue overflow — 500 records dropped" }),
    ]);
    expect(nativeInvoke.mock.calls.every(([, payload]) => payload.records.length <= 500)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("flushes on pagehide and still delivers actual errors from a hidden window", async () => {
    await installAndDrain();
    logEvent("before pagehide");
    window.dispatchEvent(new Event("pagehide"));
    await vi.advanceTimersByTimeAsync(0);
    expect(submittedRecords().map((record) => record.text)).toEqual(["before pagehide"]);
    expect(vi.getTimerCount()).toBe(0);
    vi.stubGlobal("document", { visibilityState: "hidden" });
    window.dispatchEvent(Object.assign(new Event("error"), { message: "hidden error", filename: "test.ts", lineno: 1 }));
    window.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: "hidden rejection" }));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(submittedRecords().slice(1)).toEqual([
      expect.objectContaining({ text: "window.onerror: hidden error (test.ts:1)", tags: ["window-error"] }),
      expect.objectContaining({ text: "unhandledrejection: hidden rejection", tags: ["window-error"] }),
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("installs only once and leaves browser-only logging timer-free", async () => {
    isElectron.mockReturnValue(false);
    initRendererLogCapture();
    logEvent("browser activity");
    expect(nativeInvoke).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    isElectron.mockReturnValue(true);
    initRendererLogCapture();
    initRendererLogCapture();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(nativeInvoke).toHaveBeenCalledOnce();
    expect(submittedRecords()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
