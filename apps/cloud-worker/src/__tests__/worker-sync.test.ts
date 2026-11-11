import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { BridgeMessage } from "@zeros/protocol/messages";
import { SyncSnapshotReplySchema, type SyncSnapshotReply } from "@zeros/protocol/workspace-sync";
import { CloudWorker } from "../worker";
import { CLIENT_A, CLIENT_B, FakeRelay, browserFrame, config } from "./worker-fixtures";
import { repositoryFixture } from "../workspace/__tests__/repository-fixture";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

async function fixture() {
  const f = await repositoryFixture();
  const relay = new FakeRelay();
  const worker = new CloudWorker({ directory: f.state, homeDirectory: f.directory, transport: relay, prepareCheckout: async () => {}, drivers: {}, workspaceServices: { watch: false } });
  cleanups.push(() => worker.dispose());
  worker.start();
  await relay.receive({ ...config, agents: {}, workspace: f.scope.workspace });
  const request = async (clientId: string, op: string, params: Record<string, unknown> = {}) => {
    const frame = browserFrame("WORKSPACE_REQUEST", { op, params });
    await relay.request(clientId, frame);
    return relay.response(frame.id) as Extract<BridgeMessage, { type: "WORKSPACE_RESPONSE" | "WORKSPACE_ERROR" }>;
  };
  const snapshot = async (clientId: string, params: Record<string, unknown> = {}) => {
    const reply = await request(clientId, "sync.snapshot", params);
    expect(reply.type).toBe("WORKSPACE_RESPONSE");
    return SyncSnapshotReplySchema.parse((reply as { result: unknown }).result) as SyncSnapshotReply;
  };
  const gate = (worker as unknown as { runtimeGate: { activity(): void; admit(): unknown } }).runtimeGate;
  return { ...f, relay, worker, request, snapshot, gate };
}

it("serves a syncing Mac as a passive client: never in the census, never admitted or counted as activity", async () => {
  const f = await fixture();
  const activity = vi.spyOn(f.gate, "activity"), admit = vi.spyOn(f.gate, "admit");
  await f.relay.receive({ t: "open", clientId: CLIENT_A, passive: true });
  const ready = f.relay.bridge().filter(entry => entry.clientId === CLIENT_A && entry.frame.type === "ENGINE_READY");
  expect((ready[0]!.frame as { capabilities?: string[] }).capabilities).toContain("workspace-sync-v1");
  const first = await f.snapshot(CLIENT_A);
  expect(first.full!.map(entry => entry.path)).toContain("readme.txt");
  expect(f.worker.runtimeCensus.clients).toBe(false);
  await f.relay.receive({ t: "close", clientId: CLIENT_A });
  expect(activity).not.toHaveBeenCalled();
  expect(admit).not.toHaveBeenCalled();
  // An ordinary app connection is counted and admitted, as before.
  await f.relay.receive({ t: "open", clientId: CLIENT_B });
  expect(f.worker.runtimeCensus.clients).toBe(true);
  expect(admit).toHaveBeenCalled();
});

it("lets a passive client call only sync.snapshot and sync.read, refusing every other frame unrun", async () => {
  const f = await fixture();
  await f.relay.receive({ t: "open", clientId: CLIENT_A, passive: true });
  for (const [op, params] of [["file.write", { path: "readme.txt", content: "owned\n" }], ["chats.list", {}], ["git.status", {}]] as const) {
    const reply = await f.request(CLIENT_A, op, params);
    expect(reply).toMatchObject({ type: "WORKSPACE_ERROR", code: "PASSIVE_CLIENT" });
  }
  const before = f.relay.bridge().filter(entry => entry.clientId === CLIENT_A).length;
  // Every other frame type is refused too, the handshake included.
  for (const type of ["PTY_LIST", "AGENT_LIST_AGENTS", "CONNECTED", "HEARTBEAT"]) await f.relay.request(CLIENT_A, browserFrame(type, type === "CONNECTED" ? { protocolVersion: 0 } : {}));
  expect(f.relay.bridge().filter(entry => entry.clientId === CLIENT_A)).toHaveLength(before);
  expect(await f.git("show", ":readme.txt")).toBe("initial");
});

it("hints only passive clients after a recorded batch, then answers the changes since their seq, and binds reads to the inventory's sha256", async () => {
  const f = await fixture();
  await f.relay.receive({ t: "open", clientId: CLIENT_A, passive: true });
  await f.relay.receive({ t: "open", clientId: CLIENT_B });
  const first = await f.snapshot(CLIENT_A);
  await writeFile(join(f.root, "readme.txt"), "changed\n");
  (f.worker as unknown as { sync: { changed(): void } }).sync.changed();
  const hinted = () => f.relay.bridge().filter(entry => entry.frame.type === "DB_CHANGED" && (entry.frame as { kinds: string[] }).kinds.includes("workspaceSync"));
  await expect.poll(() => hinted().map(entry => entry.clientId)).toEqual([CLIENT_A]);
  const next = await f.snapshot(CLIENT_A, { epoch: first.epoch, seq: first.seq });
  expect(next.changes).toEqual([expect.objectContaining({ path: "readme.txt", sha256: sha("changed\n"), size: 8 })]);
  const read = await f.request(CLIENT_A, "sync.read", { path: "readme.txt", sha256: sha("changed\n"), offset: 0, length: 4 });
  expect(read).toMatchObject({ type: "WORKSPACE_RESPONSE", result: { bytes: 4, base64: Buffer.from("chan").toString("base64") } });
  const stale = await f.request(CLIENT_A, "sync.read", { path: "readme.txt", sha256: sha("initial\n"), offset: 0, length: 4 });
  expect(stale).toMatchObject({ type: "WORKSPACE_ERROR", code: "SYNC_CHANGED" });
  for (const path of ["../outside", ".git/config", "/etc/passwd"]) {
    const refused = await f.request(CLIENT_A, "sync.read", { path, sha256: sha("x"), offset: 0, length: 1 });
    expect(refused).toMatchObject({ type: "WORKSPACE_ERROR", code: "VALIDATION_FAILED" });
  }
});

it("bundles the branch's history for the Mac's clone: full, then incremental from have, full again after a force-push", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { mkdtemp, writeFile: write } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const run = promisify(execFile);
  const f = await fixture();
  await f.git("remote", "add", "origin", "https://x-access-token:secret-value@github.com/example/repo.git");
  await f.relay.receive({ t: "open", clientId: CLIENT_A, passive: true });
  const ok = async (op: string, params: Record<string, unknown>) => {
    const reply = await f.request(CLIENT_A, op, params);
    expect(reply.type, JSON.stringify(reply)).toBe("WORKSPACE_RESPONSE");
    return (reply as { result: Record<string, unknown> }).result;
  };
  const fetchBundle = async (bundle: { id: string; size: number; sha256: string }) => {
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < bundle.size; offset += 7) chunks.push(Buffer.from(((await ok("sync.bundleRead", { id: bundle.id, offset, length: 7 })) as { base64: string }).base64, "base64"));
    const bytes = Buffer.concat(chunks);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(bundle.sha256);
    const path = join(await mkdtemp(join(tmpdir(), "bundle-")), "b.bundle"); await write(path, bytes); return path;
  };
  const head = await f.git("rev-parse", "HEAD"), branch = await f.git("symbolic-ref", "--short", "HEAD");
  const snapshot = await f.snapshot(CLIENT_A);
  expect(snapshot.head).toEqual({ branch, sha: head });
  const first = await ok("sync.bootstrap", {}) as { branch: string; head: string; remoteUrl: string | null; bundle: { id: string; size: number; sha256: string; full: boolean } };
  expect(first).toMatchObject({ branch, head, remoteUrl: "https://github.com/example/repo.git", bundle: { full: true } });
  expect(JSON.stringify(first)).not.toContain("secret-value");
  const clone = await mkdtemp(join(tmpdir(), "mac-clone-"));
  await run("git", ["init", "-q", clone]);
  await run("git", ["-C", clone, "fetch", "-q", await fetchBundle(first.bundle), `refs/heads/${branch}:refs/heads/${branch}`]);
  expect((await run("git", ["-C", clone, "rev-parse", branch])).stdout.trim()).toBe(head);
  expect(await ok("sync.bootstrap", { have: head })).toEqual({ branch, head, remoteUrl: "https://github.com/example/repo.git" });
  await write(join(f.root, "next.txt"), "next\n"); await f.git("add", "next.txt"); await f.git("commit", "-m", "next");
  const next = await f.git("rev-parse", "HEAD");
  const incremental = await ok("sync.bootstrap", { have: head }) as typeof first;
  expect(incremental).toMatchObject({ head: next, bundle: { full: false } });
  await run("git", ["-C", clone, "fetch", "-q", await fetchBundle(incremental.bundle), `refs/heads/${branch}:refs/heads/${branch}`]);
  expect((await run("git", ["-C", clone, "rev-parse", branch])).stdout.trim()).toBe(next);
  // A force-push: the Mac's head is no longer an ancestor, so the bundle is full.
  await f.git("reset", "--hard", head); await write(join(f.root, "other.txt"), "other\n"); await f.git("add", "other.txt"); await f.git("commit", "-m", "rewritten");
  expect(await ok("sync.bootstrap", { have: next })).toMatchObject({ bundle: { full: true } });
  expect(await f.request(CLIENT_A, "sync.bundleRead", { id: "6b0c0a2e-1f3a-4b5c-8d6e-7f8091a2b3c4", offset: 0, length: 1 })).toMatchObject({ type: "WORKSPACE_ERROR", code: "SYNC_CHANGED" });
});

it("strips credentials from the origin URL and refuses unknown forms", async () => {
  const { credentialFree } = await import("../workspace/sync-service");
  expect(credentialFree("https://x-access-token:ghs_secret@github.com/o/r.git")).toBe("https://github.com/o/r.git");
  expect(credentialFree("https://github.com/o/r.git?token=x#y")).toBe("https://github.com/o/r.git");
  expect(credentialFree("git@github.com:o/r.git")).toBe("git@github.com:o/r.git");
  for (const bad of ["", "file:///etc", "ext::sh -c touch", "http://github.com/o/r", "-uhttps://x"]) expect(credentialFree(bad)).toBeNull();
});

it("advertises sync-batch-v1 and reads several small files in one round trip, reporting a changed file per entry so the rest still land", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "a.txt"), "alpha\n"); await writeFile(join(f.root, "b.txt"), "beta\n"); await writeFile(join(f.root, "empty.txt"), "");
  await f.relay.receive({ t: "open", clientId: CLIENT_A, passive: true });
  const ready = f.relay.bridge().find(entry => entry.clientId === CLIENT_A && entry.frame.type === "ENGINE_READY");
  expect((ready!.frame as { capabilities?: string[] }).capabilities).toContain("sync-batch-v1");
  await f.snapshot(CLIENT_A);
  const reply = await f.request(CLIENT_A, "sync.readBatch", { files: [
    { path: "a.txt", sha256: sha("alpha\n") }, { path: "b.txt", sha256: sha("stale\n") }, { path: "empty.txt", sha256: sha("") }, { path: "readme.txt", sha256: sha("initial\n") }] });
  expect(reply).toMatchObject({ type: "WORKSPACE_RESPONSE", result: { entries: [
    { path: "a.txt", bytes: 6, base64: Buffer.from("alpha\n").toString("base64") },
    { path: "b.txt", changed: true },
    { path: "empty.txt", bytes: 0, base64: "" },
    { path: "readme.txt", bytes: 8, base64: Buffer.from("initial\n").toString("base64") },
  ] } });
  for (const files of [[], [{ path: "../x", sha256: sha("x") }]]) expect(await f.request(CLIENT_A, "sync.readBatch", { files })).toMatchObject({ type: "WORKSPACE_ERROR", code: "VALIDATION_FAILED" });
});

it("keeps the VM awake while a sync transfers (60 s after its last read), never for an in-sync mirror, and at most 30 continuous minutes", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const f = await fixture();
    const busy = () => (f.worker as unknown as { busy: boolean }).busy;
    await f.relay.receive({ t: "open", clientId: CLIENT_A, passive: true, device: DEVICE });
    vi.advanceTimersByTime(RECENT + 1);   // past the configuration's own recent activity
    // An in-sync mirror: snapshots and hints only.
    await f.snapshot(CLIENT_A);
    expect(busy()).toBe(false);
    // A transfer: busy for 60 s after the last read.
    await f.request(CLIENT_A, "sync.read", { path: "readme.txt", sha256: sha("initial\n"), offset: 0, length: 4 });
    expect(busy()).toBe(true);
    vi.advanceTimersByTime(59_000); expect(busy()).toBe(true);
    vi.advanceTimersByTime(2_000); expect(busy()).toBe(false);
    // Continuous reads count for at most 30 minutes.
    for (let minute = 0; minute <= 31; minute++) {
      await f.request(CLIENT_A, "sync.readBatch", { files: [{ path: "readme.txt", sha256: sha("initial\n") }] });
      if (minute < 30) expect(busy(), `minute ${minute}`).toBe(true);
      vi.advanceTimersByTime(59_000);   // under the 60 s window: one continuous run
    }
    await f.request(CLIENT_A, "sync.read", { path: "readme.txt", sha256: sha("initial\n"), offset: 0, length: 4 });
    expect(busy()).toBe(false);
    // A retry loop cannot restart the allowance: a new socket from the same Mac within the window continues its run.
    await f.relay.receive({ t: "close", clientId: CLIENT_A });
    await f.relay.receive({ t: "open", clientId: CLIENT_B, passive: true, device: DEVICE });
    await f.request(CLIENT_B, "sync.read", { path: "readme.txt", sha256: sha("initial\n"), offset: 0, length: 4 });
    expect(busy()).toBe(false);
    // After a real pause (past the window), a new run gets a new allowance.
    vi.advanceTimersByTime(61_000);
    await f.request(CLIENT_B, "sync.read", { path: "readme.txt", sha256: sha("initial\n"), offset: 0, length: 4 });
    expect(busy()).toBe(true);
  } finally { vi.useRealTimers(); }
});
const RECENT = 60_000, DEVICE = "7f1f6c1e-3b0a-4f7e-9d43-8a0b2b9c6d11";

it("reuses the same bundle for a retried bootstrap (same HEAD and have) for its lifetime, instead of rebuilding it", async () => {
  const f = await fixture();
  await f.relay.receive({ t: "open", clientId: CLIENT_A, passive: true });
  await f.snapshot(CLIENT_A);
  const boot = async (params: Record<string, unknown>) => ((await f.request(CLIENT_A, "sync.bootstrap", params)) as { result: { bundle: { id: string } } }).result.bundle;
  const first = await boot({}), retry = await boot({});
  expect(retry.id).toBe(first.id);
  // Another starting point is another bundle.
  await writeFile(join(f.root, "next.txt"), "next\n"); await f.git("add", "next.txt"); await f.git("commit", "-m", "next");
  expect((await boot({})).id).not.toBe(first.id);
});
