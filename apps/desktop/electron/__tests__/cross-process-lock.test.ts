import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { withCrossProcessFileLock } from "../cross-process-lock";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("cross-process file lock", () => {
  let directory = "";

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = "";
  });

  it("serializes two async rotations that share one lock path", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "zeros-lock-test-"));
    const lockPath = path.join(directory, "refresh.lock");
    const release = deferred();
    const entered: string[] = [];

    const first = withCrossProcessFileLock(lockPath, async () => {
      entered.push("first");
      await release.promise;
      entered.push("first-done");
    });
    while (entered.length === 0) await new Promise((done) => setTimeout(done, 1));
    const second = withCrossProcessFileLock(
      lockPath,
      async () => {
        entered.push("second");
      },
      { pollIntervalMs: 2 },
    );

    await new Promise((done) => setTimeout(done, 10));
    expect(entered).toEqual(["first"]);
    release.resolve();
    await Promise.all([first, second]);
    expect(entered).toEqual(["first", "first-done", "second"]);
  });

  // A lock that exists but cannot be snapshotted (unreadable, or not a regular
  // file) used to `continue` past both the timeout check and the sleep, turning
  // acquisition into an unbounded SYNCHRONOUS spin — in the main process that
  // wedges the event loop rather than failing. It must surface waitTimeoutMs.
  it("times out instead of spinning when the lock cannot be read", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "zeros-lock-test-"));
    const lockPath = path.join(directory, "refresh.lock");
    // A directory makes openSync(…, "wx") report EEXIST while readFileSync
    // fails, which is exactly the shape of an unreadable foreign lock.
    await mkdir(lockPath);

    const startedAt = Date.now();
    await expect(
      withCrossProcessFileLock(lockPath, async () => "unreachable", {
        staleAfterMs: 50,
        waitTimeoutMs: 120,
        pollIntervalMs: 5,
      }),
    ).rejects.toThrow(/Timed out waiting for lock/);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("recovers a lock whose owning process died", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "zeros-lock-test-"));
    const lockPath = path.join(directory, "refresh.lock");
    await writeFile(lockPath, "dead-owner", { mode: 0o600 });
    const old = new Date(Date.now() - 5_000);
    await utimes(lockPath, old, old);

    await expect(
      withCrossProcessFileLock(
        lockPath,
        async () => "recovered",
        { staleAfterMs: 100, waitTimeoutMs: 500, pollIntervalMs: 2 },
      ),
    ).resolves.toBe("recovered");
  });
});
