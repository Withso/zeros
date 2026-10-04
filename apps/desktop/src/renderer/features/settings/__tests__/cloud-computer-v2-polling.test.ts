import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudComputerV2BuildLogs } from "@zeros/protocol/cloud-computer-v2";
import { startCloudComputerV2Polling } from "../cloud-computer-v2-polling";
import {
  cloudComputerV2MaxLogEntries,
  mergeCloudComputerV2Logs,
} from "../cloud-computer-v2-client";
import { deferred } from "./cloud-computer-v2-fixtures";

vi.mock("../../../platform/cloud-workspaces", () => ({
  cloudAccountRequest: vi.fn(),
}));
const page = (
  entries: CloudComputerV2BuildLogs["entries"],
  overrides: Partial<CloudComputerV2BuildLogs> = {},
): CloudComputerV2BuildLogs => ({
  entries,
  firstSeq: entries[0]?.seq ?? null,
  lastSeq: entries.at(-1)?.seq ?? null,
  nextAfter: entries.at(-1)?.seq ?? 0,
  truncated: false,
  complete: false,
  ...overrides,
});
const row = (
  seq: number,
  text = "ready\n",
): CloudComputerV2BuildLogs["entries"][number] => ({
  seq,
  text,
  stream: "stdout",
  stage: "install",
  createdAt: "2026-10-04T10:00:00.000Z",
});
afterEach(() => {
  vi.useRealTimers();
});

describe("bounded cursor log snapshots", () => {
  it("appends ordered entries once, retains identity while idle, and rejects backwards cursors", () => {
    const first = mergeCloudComputerV2Logs(undefined, page([row(1)]));
    const next = mergeCloudComputerV2Logs(
      first,
      page([row(1), row(2)], { firstSeq: 1 }),
    );
    expect(next.entries.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(next.entries[0]).toBe(first.entries[0]);
    expect(
      mergeCloudComputerV2Logs(
        next,
        page([], { firstSeq: 1, lastSeq: 2, nextAfter: 2 }),
      ),
    ).toBe(next);
    expect(mergeCloudComputerV2Logs(next, page([row(1)]))).toBe(next);
  });
  it("marks server truncation, cursor gaps, and the local byte/row retention bounds", () => {
    expect(mergeCloudComputerV2Logs(undefined, page([row(7)]))).toMatchObject({
      truncated: true,
    });
    const bytes = mergeCloudComputerV2Logs(
      undefined,
      page(Array.from({ length: 140 }, (_, i) => row(i + 1, "x".repeat(8192)))),
    );
    expect(bytes.entries).toHaveLength(128);
    expect(bytes.truncated).toBe(true);
    const rows = mergeCloudComputerV2Logs(
      undefined,
      page(
        Array.from({ length: cloudComputerV2MaxLogEntries + 1 }, (_, i) =>
          row(i + 1),
        ),
      ),
    );
    expect(rows.entries).toHaveLength(cloudComputerV2MaxLogEntries);
    expect(rows.truncated).toBe(true);
  });
});

describe("active-only log polling", () => {
  it("polls at one second after output, backs off while idle and stops after completion", async () => {
    vi.useFakeTimers();
    const read = vi
      .fn()
      .mockResolvedValueOnce({ idle: false, complete: false })
      .mockResolvedValueOnce({ idle: true, complete: false })
      .mockResolvedValueOnce({ idle: true, complete: false })
      .mockResolvedValueOnce({ idle: false, complete: true });
    const stop = startCloudComputerV2Polling({
      read,
      visible: () => true,
      subscribeVisibility: () => () => {},
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(4000);
    expect(read).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(4);
    stop();
  });

  it("shares slow reads, stops while hidden, and never restarts after unmount", async () => {
    vi.useFakeTimers();
    let visible = true,
      changed!: () => void;
    const pending = deferred<{ idle: boolean; complete: boolean }>();
    const read = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue({ idle: false, complete: false });
    const off = vi.fn();
    const stop = startCloudComputerV2Polling({
      read,
      visible: () => visible,
      subscribeVisibility: (listener) => {
        changed = listener;
        return off;
      },
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(read).toHaveBeenCalledTimes(1);
    visible = false;
    changed();
    pending.resolve({ idle: false, complete: false });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(read).toHaveBeenCalledTimes(1);
    visible = true;
    changed();
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);
    stop();
    changed();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(read).toHaveBeenCalledTimes(2);
    expect(off).toHaveBeenCalledOnce();
  });

  it("does no cold read while the document is hidden", async () => {
    vi.useFakeTimers();
    const read = vi.fn();
    const stop = startCloudComputerV2Polling({
      read,
      visible: () => false,
      subscribeVisibility: () => () => {},
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).not.toHaveBeenCalled();
    stop();
  });
});
