import { describe, expect, it, vi } from "vitest";

import {
  CloudReplicaSessionWriter,
  seedCloudReplicaSessionToEngineIfEnabled,
  startCloudReplicaSessionRefresh,
} from "../cloud-replica-session-lifecycle";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

type Target = { id: string };

function sessionWriter(input: {
  createLine: () => Promise<string>;
  getTarget?: () => Target | null;
  write?: (target: Target, line: string) => void;
  onWarning?: (reason: string) => void;
}) {
  const target = { id: "engine-1" };
  const writes: Array<{ target: Target; line: string }> = [];
  return {
    target,
    writes,
    writer: new CloudReplicaSessionWriter<Target>({
      createLine: input.createLine,
      getTarget: input.getTarget ?? (() => target),
      write:
        input.write ??
        ((writeTarget, line) =>
          void writes.push({ target: writeTarget, line })),
      signedOutLine: "signed-out\n",
      onWarning: input.onWarning,
    }),
  };
}

describe("cloud replica session lifecycle", () => {
  it("does not seed the engine while the desktop capability is disabled", () => {
    const push = vi.fn(async () => undefined);

    expect(
      seedCloudReplicaSessionToEngineIfEnabled({
        capabilityEnabled: () => false,
        push,
      }),
    ).toBe(false);
    expect(push).not.toHaveBeenCalled();
  });

  it("does not install a refresh timer while the desktop capability is disabled", () => {
    const refresh = vi.fn(async () => undefined);
    const schedule = vi.fn();
    const cancel = vi.fn();

    const dispose = startCloudReplicaSessionRefresh({
      capabilityEnabled: () => false,
      refresh,
      schedule,
      cancel,
    });

    expect(schedule).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    dispose();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("preserves explicit session seed and refresh behavior when enabled", () => {
    const push = vi.fn(async () => undefined);
    expect(
      seedCloudReplicaSessionToEngineIfEnabled({
        capabilityEnabled: () => true,
        push,
      }),
    ).toBe(true);
    expect(push).toHaveBeenCalledOnce();

    let tick: (() => void) | undefined;
    const timer = { unref: vi.fn() };
    const schedule = vi.fn((callback: () => void) => {
      tick = callback;
      return timer as unknown as ReturnType<typeof setInterval>;
    });
    const cancel = vi.fn();
    const refresh = vi.fn(async () => undefined);
    const dispose = startCloudReplicaSessionRefresh({
      capabilityEnabled: () => true,
      refresh,
      schedule,
      cancel,
    });

    expect(schedule).toHaveBeenCalledWith(expect.any(Function), 45_000);
    expect(timer.unref).toHaveBeenCalledOnce();
    tick?.();
    expect(refresh).toHaveBeenCalledOnce();
    dispose();
    expect(cancel).toHaveBeenCalledWith(timer);
  });

  it("reports and contains a rejected initial seed", async () => {
    const onError = vi.fn();

    expect(
      seedCloudReplicaSessionToEngineIfEnabled({
        capabilityEnabled: () => true,
        push: async () => {
          throw new Error("seed rejected");
        },
        onError,
      }),
    ).toBe(true);

    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
  });

  it("reports and contains a synchronously throwing initial seed", () => {
    const onError = vi.fn();

    expect(
      seedCloudReplicaSessionToEngineIfEnabled({
        capabilityEnabled: () => true,
        push: () => {
          throw new Error("seed threw");
        },
        onError,
      }),
    ).toBe(true);
    expect(onError).toHaveBeenCalledOnce();
  });

  it("drops a stale bearer completion after a newer signed-out update", async () => {
    const stale = deferred<string>();
    const createLine = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(() => stale.promise)
      .mockResolvedValueOnce("signed-out\n");
    const { writer, writes } = sessionWriter({ createLine });

    const oldUpdate = writer.push();
    const signedOutUpdate = writer.push();
    await signedOutUpdate;
    stale.resolve("old-bearer\n");
    await oldUpdate;

    expect(writes.map(({ line }) => line)).toEqual(["signed-out\n"]);
  });

  it("drops stale null and error fallbacks after a newer bearer update", async () => {
    const staleNull = deferred<string>();
    const staleError = deferred<string>();
    const createLine = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(() => staleNull.promise)
      .mockResolvedValueOnce("current-bearer\n")
      .mockImplementationOnce(() => staleError.promise)
      .mockResolvedValueOnce("newest-bearer\n");
    const onWarning = vi.fn();
    const { writer, writes } = sessionWriter({ createLine, onWarning });

    const oldNullUpdate = writer.push();
    await writer.push();
    staleNull.resolve("signed-out\n");
    await oldNullUpdate;

    const oldFailedUpdate = writer.push();
    await writer.push();
    staleError.reject(new Error("contained session read failure"));
    await oldFailedUpdate;

    expect(writes.map(({ line }) => line)).toEqual([
      "current-bearer\n",
      "newest-bearer\n",
    ]);
    expect(onWarning).toHaveBeenCalledWith("session_read_failed");
  });

  it("never writes a completed session to an old engine child", async () => {
    const stale = deferred<string>();
    let currentTarget: Target | null = { id: "engine-1" };
    const createLine = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(() => stale.promise)
      .mockResolvedValueOnce("current-bearer\n");
    const writes: Array<{ target: Target; line: string }> = [];
    const { writer } = sessionWriter({
      createLine,
      getTarget: () => currentTarget,
      write: (target, line) => void writes.push({ target, line }),
    });

    const oldChildUpdate = writer.push();
    currentTarget = { id: "engine-2" };
    await writer.push();
    stale.resolve("old-bearer\n");
    await oldChildUpdate;

    expect(writes).toEqual([
      { target: { id: "engine-2" }, line: "current-bearer\n" },
    ]);
  });

  it("contains synchronous engine writer failures with a stable reason", async () => {
    const onWarning = vi.fn();
    const { writer } = sessionWriter({
      createLine: async () => "current-bearer\n",
      write: () => {
        throw new Error("pipe included sensitive implementation detail");
      },
      onWarning,
    });

    await expect(writer.push()).resolves.toBeUndefined();
    expect(onWarning).toHaveBeenCalledWith("session_write_failed");
    expect(JSON.stringify(onWarning.mock.calls)).not.toContain("sensitive");
  });
});
