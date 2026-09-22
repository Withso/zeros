import { afterEach, describe, expect, it, vi } from "vitest";
import { statfs } from "node:fs/promises";
import {
  publicationMinimumFreeBytes,
  withPublicationDiskBudget,
} from "../cloud-workspace-validation/lib/publication-disk-budget";
vi.mock("node:fs/promises", () => ({ statfs: vi.fn() }));

afterEach(() => vi.useRealTimers());

describe("publication host disk budget", () => {
  it("monitors the Docker data filesystem as well as the temporary context filesystem", async () => {
    vi.mocked(statfs).mockImplementation(
      async (directory) =>
        ({
          bavail: directory === "/docker-data" ? 1n : 100n,
          bsize: 10n,
        }) as Awaited<ReturnType<typeof statfs>>,
    );
    const operation = vi.fn(async () => "published");
    await expect(
      withPublicationDiskBudget(
        {
          directory: "/tmp",
          additionalDirectories: ["/docker-data"],
          minimumFreeBytes: 100n,
        },
        operation,
      ),
    ).rejects.toThrow(/disk headroom/);
    expect(operation).not.toHaveBeenCalled();
  });
  it("accepts only explicit byte counts and leaves unconfigured callers unchanged", () => {
    expect(publicationMinimumFreeBytes(undefined)).toBe(0n);
    expect(publicationMinimumFreeBytes("2147483648")).toBe(2147483648n);
    for (const invalid of [
      "",
      "-1",
      "1.5",
      "2g",
      "1e3",
      " 42",
      "9999999999999999",
    ]) {
      expect(() => publicationMinimumFreeBytes(invalid)).toThrow(/byte count/);
    }
  });

  it("refuses to start the build when host disk headroom is already exhausted", async () => {
    const operation = vi.fn(async () => "published");
    await expect(
      withPublicationDiskBudget(
        {
          directory: "/tmp",
          minimumFreeBytes: 100n,
          readFreeBytes: async () => 99n,
        },
        operation,
      ),
    ).rejects.toThrow(/disk headroom/);
    expect(operation).not.toHaveBeenCalled();
  });

  it("cancels an active build when available disk falls below the reserve", async () => {
    vi.useFakeTimers();
    const readFreeBytes = vi
      .fn()
      .mockResolvedValueOnce(101n)
      .mockResolvedValue(99n);
    const task = withPublicationDiskBudget(
      {
        directory: "/tmp",
        minimumFreeBytes: 100n,
        pollIntervalMs: 50,
        readFreeBytes,
      },
      (signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        ),
    );
    const assertion = expect(task).rejects.toThrow(/disk headroom/);
    await vi.advanceTimersByTimeAsync(51);
    await assertion;
    const reads = readFreeBytes.mock.calls.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(readFreeBytes).toHaveBeenCalledTimes(reads);
  });

  it("fails closed without reflecting filesystem error details", async () => {
    const operation = vi.fn(async () => "published");
    await expect(
      withPublicationDiskBudget(
        {
          directory: "/tmp",
          minimumFreeBytes: 100n,
          readFreeBytes: async () => {
            throw new Error("sensitive filesystem context");
          },
        },
        operation,
      ),
    ).rejects.toThrow("Publication disk headroom could not be measured");
    expect(operation).not.toHaveBeenCalled();
  });

  it("retains successful operation results and stops its monitor", async () => {
    vi.useFakeTimers();
    const readFreeBytes = vi.fn(async () => 100n);
    await expect(
      withPublicationDiskBudget(
        {
          directory: "/tmp",
          minimumFreeBytes: 100n,
          pollIntervalMs: 50,
          readFreeBytes,
        },
        async () => "published",
      ),
    ).resolves.toBe("published");
    const reads = readFreeBytes.mock.calls.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(readFreeBytes).toHaveBeenCalledTimes(reads);
  });

  it("does not inspect local disk for callers that have not configured a host budget", async () => {
    const readFreeBytes = vi.fn(async () => 0n);
    await expect(
      withPublicationDiskBudget(
        { directory: "/tmp", minimumFreeBytes: 0n, readFreeBytes },
        async () => "published",
      ),
    ).resolves.toBe("published");
    expect(readFreeBytes).not.toHaveBeenCalled();
  });

  it("does not accept success from an operation that ignored its abort signal", async () => {
    vi.useFakeTimers();
    const readFreeBytes = vi
      .fn()
      .mockResolvedValueOnce(101n)
      .mockResolvedValue(99n);
    let complete!: (result: string) => void;
    const report = vi.fn(() => {
      throw new Error("diagnostic sink unavailable");
    });
    const task = withPublicationDiskBudget(
      {
        directory: "/tmp",
        minimumFreeBytes: 100n,
        pollIntervalMs: 50,
        readFreeBytes,
        report,
      },
      () =>
        new Promise<string>((resolve) => {
          complete = resolve;
        }),
    );
    const assertion = expect(task).rejects.toThrow(/disk headroom/);
    await vi.advanceTimersByTimeAsync(51);
    complete("published");
    await assertion;
    expect(report).toHaveBeenCalledOnce();
  });

  it("fences a pending filesystem read after publication and never overlaps reads", async () => {
    vi.useFakeTimers();
    let freeBytes!: (result: bigint) => void;
    const readFreeBytes = vi
      .fn()
      .mockResolvedValueOnce(101n)
      .mockImplementation(
        () =>
          new Promise<bigint>((resolve) => {
            freeBytes = resolve;
          }),
      );
    let complete!: (result: string) => void;
    let signal!: AbortSignal;
    const task = withPublicationDiskBudget(
      {
        directory: "/tmp",
        minimumFreeBytes: 100n,
        pollIntervalMs: 50,
        readFreeBytes,
      },
      (currentSignal) => {
        signal = currentSignal;
        return new Promise<string>((resolve) => {
          complete = resolve;
        });
      },
    );
    await vi.advanceTimersByTimeAsync(501);
    expect(readFreeBytes).toHaveBeenCalledTimes(2);
    complete("published");
    await expect(task).resolves.toBe("published");
    freeBytes(0n);
    await vi.advanceTimersByTimeAsync(500);
    expect(signal.aborted).toBe(false);
    expect(readFreeBytes).toHaveBeenCalledTimes(2);
  });
});
