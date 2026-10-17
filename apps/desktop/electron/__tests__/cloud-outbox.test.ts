import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CloudOutbox,
  createCloudOutboxIfEnabled,
  type CloudOutboxEntry,
  type CloudOutboxSender,
} from "../cloud-outbox";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function directory() {
  const root = await mkdtemp(path.join(tmpdir(), "zeros-outbox-"));
  roots.push(root);
  return path.join(root, "outbox");
}

const ACCOUNT_A = "account-a";
const ACCOUNT_B = "account-b";
const ORGANIZATION = "22222222-2222-4222-8222-222222222222";
const WORKSPACE = "33333333-3333-4333-8333-333333333333";

type Harness = {
  send: CloudOutboxSender;
  sent: CloudOutboxEntry[];
  timers: { delayMs: number; run: () => void }[];
  settled: CloudOutboxEntry[];
  runNextTimer: () => Promise<void>;
};

function harness(impl: (entry: CloudOutboxEntry) => Promise<{ status: number; replayed: boolean }>): Harness {
  const sent: CloudOutboxEntry[] = [];
  const timers: { delayMs: number; run: () => void }[] = [];
  const settled: CloudOutboxEntry[] = [];
  const send: CloudOutboxSender = async (entry) => {
    sent.push({ ...entry });
    return impl(entry);
  };
  return {
    send,
    sent,
    timers,
    settled,
    runNextTimer: async () => {
      throw new Error("harness is not bound to an outbox yet");
    },
  };
}

function sendError(input: { status?: number; code?: string; networkError?: boolean; retryable?: boolean }): Error {
  return Object.assign(new Error(input.code ?? "send failed"), {
    status: input.status,
    code: input.code,
    networkError: input.networkError === true,
    body: input.retryable === undefined ? undefined : { error: { code: input.code ?? "x", retryable: input.retryable } },
  });
}

function openOutbox(dir: string, accountId: string, h: Harness): CloudOutbox {
  const outbox = new CloudOutbox({
    accountId,
    directory: dir,
    send: h.send,
    now: () => 1_760_000_000_000,
    schedule: (delayMs, run) => h.timers.push({ delayMs, run }),
    onSettled: (entry) => h.settled.push({ ...entry }),
  });
  // runNextTimer needs the live instance for idle flushing.
  h.runNextTimer = async () => {
    const timer = h.timers.shift();
    expect(timer).toBeDefined();
    timer!.run();
    await outbox.whenIdle();
  };
  return outbox;
}

describe("CloudOutbox", () => {
  it("keeps the same Idempotency-Key across every retry", async () => {
    const dir = await directory();
    let calls = 0;
    const h = harness(async () => {
      calls += 1;
      if (calls < 3) throw sendError({ status: 503 });
      return { status: 202, replayed: false };
    });
    const outbox = openOutbox(dir, ACCOUNT_A, h);
    const entry = outbox.enqueue({ operation: "wake", organizationId: ORGANIZATION, workspaceId: WORKSPACE });
    await outbox.drain();
    expect(h.sent).toHaveLength(1);
    await h.runNextTimer();
    await h.runNextTimer();
    expect(h.sent).toHaveLength(3);
    expect(new Set(h.sent.map((sent) => sent.id))).toEqual(new Set([entry.id]));
    expect(outbox.list().find((candidate) => candidate.id === entry.id)?.state).toBe("completed");
  });

  it("sends an entry enqueued while an empty drain pass is still settling", async () => {
    const dir = await directory();
    const h = harness(async () => ({ status: 202, replayed: false }));
    const outbox = openOutbox(dir, ACCOUNT_A, h);
    const opening = outbox.drain();
    const entry = outbox.enqueue({ operation: "wake", organizationId: ORGANIZATION, workspaceId: WORKSPACE });
    void outbox.drain();
    await opening;
    await outbox.whenIdle();
    expect(h.sent.map((sent) => sent.id)).toEqual([entry.id]);
  });

  it("settles a replayed response exactly once", async () => {
    const dir = await directory();
    const h = harness(async () => ({ status: 202, replayed: true }));
    const outbox = openOutbox(dir, ACCOUNT_A, h);
    outbox.enqueue({ operation: "stop", organizationId: ORGANIZATION, workspaceId: WORKSPACE });
    await outbox.drain();
    await outbox.drain();
    expect(h.sent).toHaveLength(1);
    expect(h.settled).toHaveLength(1);
    expect(h.settled[0]).toMatchObject({ state: "completed", replayed: true });
  });

  it("fails a terminal 4xx once and never retries it", async () => {
    const dir = await directory();
    const h = harness(async () => {
      throw sendError({ status: 409, code: "workspace_archived" });
    });
    const outbox = openOutbox(dir, ACCOUNT_A, h);
    outbox.enqueue({ operation: "wake", organizationId: ORGANIZATION, workspaceId: WORKSPACE });
    await outbox.drain();
    expect(h.timers).toHaveLength(0);
    expect(h.settled).toHaveLength(1);
    expect(h.settled[0]).toMatchObject({ state: "failed", lastError: { code: "workspace_archived", status: 409 } });
    await outbox.drain();
    expect(h.sent).toHaveLength(1);
  });

  it("retries a body-marked retryable failure with full jitter within 250ms-30s bounds", async () => {
    const dir = await directory();
    const h = harness(async () => {
      throw sendError({ status: 500, code: "upstream", retryable: true });
    });
    const outbox = openOutbox(dir, ACCOUNT_A, h);
    outbox.enqueue({ operation: "archive", organizationId: ORGANIZATION, workspaceId: WORKSPACE });
    await outbox.drain();
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0]!.delayMs).toBeGreaterThanOrEqual(0);
    expect(h.timers[0]!.delayMs).toBeLessThanOrEqual(250);
  });

  it("never sends account A's command as account B across a switch and back", async () => {
    const dir = await directory();
    const hA = harness(async () => ({ status: 202, replayed: false }));
    const hB = harness(async () => ({ status: 202, replayed: false }));
    const outboxA = openOutbox(dir, ACCOUNT_A, hA);
    outboxA.enqueue({ operation: "rename", organizationId: ORGANIZATION, workspaceId: WORKSPACE, body: { name: "new-name" } });
    outboxA.close();
    // Signed in as B: B's outbox drains nothing of A's.
    const outboxB = openOutbox(dir, ACCOUNT_B, hB);
    await outboxB.drain();
    expect(hB.sent).toHaveLength(0);
    // Back as A with a fresh process view: A's pending command resumes as A.
    const hA2 = harness(async () => ({ status: 202, replayed: false }));
    const reopenedA = openOutbox(dir, ACCOUNT_A, hA2);
    await reopenedA.drain();
    expect(hA2.sent).toHaveLength(1);
    expect(hA2.sent[0]).toMatchObject({ operation: "rename", body: { name: "new-name" } });
  });

  it("survives a restart with a pending retry and settles it then", async () => {
    const dir = await directory();
    const h1 = harness(async () => {
      throw sendError({ networkError: true });
    });
    const first = openOutbox(dir, ACCOUNT_A, h1);
    const entry = first.enqueue({ operation: "wake", organizationId: ORGANIZATION, workspaceId: WORKSPACE });
    await first.drain();
    expect(h1.timers).toHaveLength(1);
    first.close();
    // The process dies before the retry timer fires. Next boot resumes it.
    const h2 = harness(async () => ({ status: 202, replayed: true }));
    const restarted = openOutbox(dir, ACCOUNT_A, h2);
    await restarted.drain();
    expect(h2.sent).toHaveLength(1);
    expect(h2.sent[0]!.id).toBe(entry.id);
    expect(h2.sent[0]!.attempts).toBe(1);
    expect(restarted.list()[0]).toMatchObject({ state: "completed", replayed: true });
  });

  it("clears the account's outbox on sign-out", async () => {
    const dir = await directory();
    const h = harness(async () => ({ status: 202, replayed: false }));
    const outbox = openOutbox(dir, ACCOUNT_A, h);
    outbox.enqueue({ operation: "wake", organizationId: ORGANIZATION, workspaceId: WORKSPACE });
    outbox.enqueue({ operation: "stop", organizationId: ORGANIZATION, workspaceId: WORKSPACE });
    outbox.clear();
    expect(outbox.list()).toHaveLength(0);
    const reopened = openOutbox(dir, ACCOUNT_A, h);
    expect(reopened.list()).toHaveLength(0);
  });

  it("refuses to persist capabilities, tickets or tokens", async () => {
    const dir = await directory();
    const h = harness(async () => ({ status: 202, replayed: false }));
    const outbox = openOutbox(dir, ACCOUNT_A, h);
    expect(() =>
      outbox.enqueue({
        operation: "create",
        organizationId: ORGANIZATION,
        body: { name: "x", capabilities: { engine: "token" } },
      }),
    ).toThrow(/never stores/i);
    expect(() =>
      outbox.enqueue({ operation: "create", organizationId: ORGANIZATION, body: { nested: { ticket: "abc" } } }),
    ).toThrow(/never stores/i);
    expect(outbox.list()).toHaveLength(0);
  });

  it("bounds the outbox at 500 entries and expires entries after 7 days", async () => {
    const dir = await directory();
    const h = harness(async () => ({ status: 202, replayed: false }));
    const outbox = new CloudOutbox({
      accountId: ACCOUNT_A,
      directory: dir,
      send: h.send,
      now: () => 1_760_000_000_000,
      maxEntries: 3,
    });
    outbox.enqueue({ operation: "wake", organizationId: ORGANIZATION, workspaceId: WORKSPACE });
    outbox.enqueue({ operation: "stop", organizationId: ORGANIZATION, workspaceId: WORKSPACE });
    outbox.enqueue({ operation: "archive", organizationId: ORGANIZATION, workspaceId: WORKSPACE });
    expect(() => outbox.enqueue({ operation: "delete", organizationId: ORGANIZATION, workspaceId: WORKSPACE }))
      .toThrow(/full/i);
    // An entry created more than 7 days ago is pruned on load.
    const stale = new CloudOutbox({
      accountId: ACCOUNT_B,
      directory: dir,
      send: h.send,
      now: () => 1_760_000_000_000,
    });
    stale.enqueue({ operation: "wake", organizationId: ORGANIZATION, workspaceId: WORKSPACE });
    stale.close();
    const later = new CloudOutbox({
      accountId: ACCOUNT_B,
      directory: dir,
      send: h.send,
      now: () => 1_760_000_000_000 + 8 * 24 * 60 * 60 * 1000,
    });
    expect(later.list()).toHaveLength(0);
  });

  it("never lets a closed instance overwrite the file a reopened instance owns", async () => {
    const dir = await directory();
    let release!: () => void;
    const first = openOutbox(dir, ACCOUNT_A, harness(() => new Promise((resolve) => {
      release = () => resolve({ status: 202, replayed: false });
    })));
    first.enqueue({ operation: "wake", organizationId: ORGANIZATION, workspaceId: WORKSPACE });
    const inFlight = first.drain();
    // A session change closes the instance mid-send and opens a fresh one.
    first.close();
    const second = openOutbox(dir, ACCOUNT_A, harness(async () => ({ status: 202, replayed: false })));
    const added = second.enqueue({ operation: "stop", organizationId: ORGANIZATION, workspaceId: WORKSPACE });
    release();
    await inFlight;
    const reopened = openOutbox(dir, ACCOUNT_A, harness(async () => ({ status: 202, replayed: false })));
    expect(reopened.list().map((entry) => entry.id)).toContain(added.id);
    expect(reopened.list()).toHaveLength(2);
  });

  it("expires entries older than 7 days in a long-running process", async () => {
    const dir = await directory();
    let now = 1_760_000_000_000;
    const h = harness(async () => ({ status: 202, replayed: false }));
    const outbox = new CloudOutbox({ accountId: ACCOUNT_A, directory: dir, send: h.send, now: () => now,
      schedule: (delayMs, run) => h.timers.push({ delayMs, run }) });
    outbox.enqueue({ operation: "wake", organizationId: ORGANIZATION, workspaceId: WORKSPACE });
    now += 8 * 24 * 60 * 60 * 1000;
    const fresh = outbox.enqueue({ operation: "stop", organizationId: ORGANIZATION, workspaceId: WORKSPACE });
    expect(outbox.list().map((entry) => entry.id)).toEqual([fresh.id]);
    await outbox.drain();
    expect(h.sent.map((entry) => entry.id)).toEqual([fresh.id]);
  });

  it("moves a corrupt file aside instead of replaying unknown state", async () => {
    const dir = await directory();
    const h = harness(async () => ({ status: 202, replayed: false }));
    const outbox = openOutbox(dir, ACCOUNT_A, h);
    outbox.enqueue({ operation: "wake", organizationId: ORGANIZATION, workspaceId: WORKSPACE });
    outbox.close();
    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(dir, files[0]!), "not json at all");
    const reopened = openOutbox(dir, ACCOUNT_A, h);
    expect(reopened.list()).toHaveLength(0);
    const after = await readdir(dir);
    expect(after.some((name) => name.endsWith(".corrupt"))).toBe(true);
  });
});

describe("createCloudOutboxIfEnabled", () => {
  it("never constructs or reads the outbox when the desktop capability is off", async () => {
    const open = vi.fn(() => {
      throw new Error("must not open");
    });
    const result = createCloudOutboxIfEnabled({
      capabilityEnabled: () => false,
      open,
    });
    expect(result).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });

  it("opens through the injected seam when enabled", async () => {
    const dir = await directory();
    const h = harness(async () => ({ status: 202, replayed: false }));
    const result = createCloudOutboxIfEnabled({
      capabilityEnabled: () => true,
      open: () => new CloudOutbox({ accountId: ACCOUNT_A, directory: dir, send: h.send }),
    });
    expect(result).toBeInstanceOf(CloudOutbox);
    result?.close();
  });
});
