import { generateKeyPairSync, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CloudRecovery } from "./recovery.js";
import { CHECKPOINT_PARTIAL, SUBMODULE_UNRESTORED } from "./checkpoint.js";
import type { RecoveryAttempt } from "./recovery-store.js";

function fixture(phase: RecoveryAttempt["phase"] = "waiting") {
  const now = Date.now(), id = randomUUID(), workspaceId = randomUUID();
  const attempt = { id, workspace_id: workspaceId, phase, lease_id: randomUUID(), created_at: new Date(now),
    updated_at: new Date(now), deadline_at: new Date(now + 40 * 60_000), source_sandbox_id: "bx_sourcefixture",
    source_boot_id: randomUUID(), source_runtime_sha256: "a".repeat(64), source_stopped_at: null,
    replacement_create: null, replacement_sandbox_id: null, replacement_boot_id: null, checkpoint_object: null,
    checkpoint_upload_until: null, completed_at: null, first_error_code: null, setup_succeeded_at: null,
    worker_ready_at: null, disk_verified_at: null, source_deleted_at: null, replacement_deleted_at: null } as RecoveryAttempt;
  const workspace = { id: workspaceId, repository: "fixture/project", baseBranch: "main", state: "running", stopGeneration: "0" };
  const store = { claim: vi.fn(async () => attempt), read: vi.fn(async () => attempt), workspace: vi.fn(async () => workspace),
    canFence: vi.fn(async () => true), fence: vi.fn(async () => true), fail: vi.fn(), defer: vi.fn(),
    startCapture: vi.fn(async () => true), stopped: vi.fn(async () => true), ready: vi.fn(async () => true), succeed: vi.fn(async () => false),
    ownedSandbox: vi.fn(async (_sandbox: string) => true), sourceDisposable: vi.fn(async () => true),
    ownedCheckpoint: vi.fn(async () => false), deletedSandbox: vi.fn(), purge: vi.fn(async () => false) };
  const compute = { exec: vi.fn(), stop: vi.fn(), delete: vi.fn(), findSandbox: vi.fn(async () => null) };
  const checkpoints = { storage: { uploadUrl: vi.fn(), downloadUrl: vi.fn(), size: vi.fn(), delete: vi.fn() }, seal: vi.fn(), open: vi.fn() };
  const authorize = vi.fn(), githubToken = vi.fn(async () => ({ token: "synthetic-github" })), ready = vi.fn(async () => true);
  const recovery = new CloudRecovery({ store, compute, checkpoints, authorize, githubToken, ready,
    runtime: { sha256: "a".repeat(64), url: vi.fn() }, publicKeys: [], sealToken: vi.fn(), openToken: vi.fn(),
    bootEnv: vi.fn(async () => ({})), sandboxName: vi.fn(() => "fixture-recovery"), now: () => now } as never);
  return { recovery, attempt, store, compute, checkpoints, authorize, githubToken, ready, now };
}

describe("fresh checkpoint recovery coordinator", () => {
  it("waits for queued work without fencing or fetching an initiator credential", async () => {
    const f = fixture(); f.store.canFence.mockResolvedValue(false);
    await f.recovery.run(f.attempt.id);
    expect(f.store.fence).not.toHaveBeenCalled(); expect(f.githubToken).not.toHaveBeenCalled(); expect(f.compute.exec).not.toHaveBeenCalled();
  });
  describe("a workspace of several repositories", () => {
    const several = (f: ReturnType<typeof fixture>) => {
      f.store.workspace.mockResolvedValue({ id: f.attempt.workspace_id, repository: "fixture/project", baseBranch: "main", state: "running", stopGeneration: "0",
        folder: "zeros-app", checkoutFolder: "zeros-app/project" } as never);
      const repositories = vi.fn(async () => [{ repository: "fixture/web", repositoryId: "43", checkoutFolder: "zeros-app/web", baseBranch: "main" }]);
      (f.recovery as unknown as { deps: { repositories: typeof repositories } }).deps.repositories = repositories;
      return repositories;
    };
    it("recovers like a workspace of one: it is fenced, not refused", async () => {
      const f = fixture(); several(f);
      await f.recovery.run(f.attempt.id);
      expect(f.store.fail).not.toHaveBeenCalled(); expect(f.store.fence).toHaveBeenCalled();
    });
    it("captures every repository, each in its own part of the archive", async () => {
      const f = fixture("capturing"); several(f); f.attempt.source_stopped_at = new Date(f.now - 1);
      f.store.upload = vi.fn(async () => true) as never; f.checkpoints.seal.mockReturnValue({} as never);
      f.checkpoints.storage.uploadUrl.mockResolvedValue("https://r2.example.test/upload?sig=1" as never);
      f.compute.exec.mockResolvedValue({ exitCode: 1, timedOut: false, stdout: "" });
      await f.recovery.run(f.attempt.id);
      const command = String(f.compute.exec.mock.calls.at(-1)![1]);
      expect(command).toContain("/home/user/zeros-app/web");
      expect(command).toContain("repositories/1");
    });
    it("restores every repository, fetching each with its own token minted for it", async () => {
      const f = fixture("restoring"); several(f);
      Object.assign(f.attempt, { replacement_create: { name: "fixture-recovery", env: {}, from: "snapshot-fixture" }, replacement_sandbox_id: "bx_replacement",
        replacement_runtime_sha256: "a".repeat(64), checkpoint_object: "object-fixture", checkpoint_sha256: "b".repeat(64), checkpoint_key: {} });
      Object.assign(f.store, { claimRestore: vi.fn(async () => true), restored: vi.fn(async () => true) });
      f.githubToken.mockImplementation((async (_workspace: unknown, repository?: { repository: string }) =>
        ({ token: repository ? "synthetic-web-token-0123456789" : "synthetic-first-token-0123456789" })) as never);
      f.checkpoints.open.mockReturnValue(Buffer.alloc(32, 1) as never);
      f.checkpoints.storage.downloadUrl.mockResolvedValue("https://r2.example.test/download?sig=1" as never);
      f.compute.exec.mockResolvedValue({ exitCode: 0, timedOut: false, stdout: "zeros-checkpoint-restored\n" });
      const deps = (f.recovery as unknown as { deps: { runtime: { url: ReturnType<typeof vi.fn> }; publicKeys: string[] } }).deps;
      deps.runtime.url.mockResolvedValue("https://runtime.example.test/worker.tgz");
      deps.publicKeys = [generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString()];
      await f.recovery.run(f.attempt.id);
      expect(f.store.fail.mock.calls).toEqual([]);
      expect(f.githubToken).toHaveBeenCalledWith(expect.anything(), { repository: "fixture/web", repositoryId: "43" });
      const command = String(f.compute.exec.mock.calls.at(-1)![1]);
      expect(command).toContain("https://github.com/fixture/web.git");
      expect(command).toContain(Buffer.from("synthetic-web-token-0123456789").toString("base64")); // gitleaks:allow
    });
  });
  describe("a workspace with fetched submodules (C4B)", () => {
    const GIT_DIR = `modules/${"d".repeat(64)}`;
    const lib = { position: 0, repository: "acme/lib", repositoryId: "42", checkoutFolder: "fixture/project/lib", repositoryFolder: "fixture/project",
      baseCommit: "c".repeat(40), gitDir: GIT_DIR };
    const withSubmodules = (f: ReturnType<typeof fixture>) => {
      const deps = (f.recovery as unknown as { deps: Record<string, unknown> }).deps;
      const recorded = vi.fn(async () => {}), submoduleToken = vi.fn(async () => ({ token: "synthetic-lib-token-0123456789" }));
      Object.assign(deps, { checkouts: vi.fn(async () => ({ repositories: [], submodules: [lib] })), submoduleToken, recordUnrestoredSubmodules: recorded });
      return { recorded, submoduleToken };
    };
    it("captures each fetched submodule as a stop does, and keeps a capture that left one out as partial", async () => {
      const f = fixture("capturing"); withSubmodules(f); f.attempt.source_stopped_at = new Date(f.now - 1);
      f.attempt.checkpoint_object = null;
      const captured = vi.fn(async () => true);
      Object.assign(f.store, { upload: vi.fn(async () => true), captured });
      f.checkpoints.seal.mockReturnValue({} as never);
      f.checkpoints.storage.uploadUrl.mockResolvedValue("https://r2.example.test/upload?sig=1" as never);
      f.checkpoints.storage.size.mockResolvedValue(100 as never);
      f.compute.exec.mockResolvedValue({ exitCode: 0, timedOut: false, stdout: `${CHECKPOINT_PARTIAL}\nzeros-checkpoint-saved bytes=100 sha256=${"e".repeat(64)}\n` });
      await f.recovery.run(f.attempt.id);
      const command = String(f.compute.exec.mock.calls.at(-1)![1]);
      expect(command).toContain("/home/user/fixture/project/lib");
      expect(command).toContain(GIT_DIR);
      expect(captured).toHaveBeenCalledWith(f.attempt.id, f.attempt.lease_id, expect.objectContaining({ partial: true }));
    });
    it("restores each fetched submodule into the new Git directory with its own token, and records one it could not put back", async () => {
      const f = fixture("restoring"); const { recorded, submoduleToken } = withSubmodules(f);
      Object.assign(f.attempt, { replacement_create: { name: "fixture-recovery", env: {}, from: "snapshot-fixture" }, replacement_sandbox_id: "bx_replacement",
        replacement_runtime_sha256: "a".repeat(64), checkpoint_object: "object-fixture", checkpoint_sha256: "b".repeat(64), checkpoint_key: {} });
      Object.assign(f.store, { claimRestore: vi.fn(async () => true), restored: vi.fn(async () => true) });
      f.checkpoints.open.mockReturnValue(Buffer.alloc(32, 1) as never);
      f.checkpoints.storage.downloadUrl.mockResolvedValue("https://r2.example.test/download?sig=1" as never);
      f.compute.exec.mockResolvedValue({ exitCode: 0, timedOut: false, stdout: `zeros-checkpoint-restored\n${SUBMODULE_UNRESTORED} 1 checkpoint_repository_missing\n` });
      const deps = (f.recovery as unknown as { deps: { runtime: { url: ReturnType<typeof vi.fn> }; publicKeys: string[] } }).deps;
      deps.runtime.url.mockResolvedValue("https://runtime.example.test/worker.tgz");
      deps.publicKeys = [generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString()];
      await f.recovery.run(f.attempt.id);
      expect(f.store.fail.mock.calls).toEqual([]);
      expect(submoduleToken).toHaveBeenCalledWith(expect.anything(), "acme/lib");
      const command = String(f.compute.exec.mock.calls.at(-1)![1]);
      expect(command).toContain("https://github.com/acme/lib.git");
      expect(command).toContain(GIT_DIR);
      expect(recorded).toHaveBeenCalledWith(f.attempt.workspace_id, { restored: [],
        failed: [{ position: 0, path: "lib", folder: "/home/user/fixture/project/lib", reason: "repository_unavailable" }] });
    });
  });
  it("keeps the source running when the initiator lacks restore GitHub authority", async () => {
    const f = fixture(); f.githubToken.mockRejectedValue({ code: "github_access_required" });
    await f.recovery.run(f.attempt.id);
    expect(f.store.fail).toHaveBeenCalledWith(f.attempt.id, "github_access_required", f.attempt.lease_id);
    expect(f.store.fence).not.toHaveBeenCalled(); expect(f.compute.stop).not.toHaveBeenCalled(); expect(f.compute.exec).not.toHaveBeenCalled();
  });
  it("never uploads a checkpoint unless the source shutdown was verified", async () => {
    const f = fixture("capturing"); f.compute.exec.mockResolvedValue({ exitCode: 0, timedOut: false, stdout: "zeros-recovery-refused\n" });
    await f.recovery.run(f.attempt.id);
    expect(f.store.fail).toHaveBeenCalledWith(f.attempt.id, "recovery_shutdown_unconfirmed", f.attempt.lease_id);
    expect(f.checkpoints.storage.uploadUrl).not.toHaveBeenCalled(); expect(f.compute.delete).not.toHaveBeenCalled();
  });
  it("does not retry an uncertain fresh capture or substitute the previous archive", async () => {
    const f = fixture("capturing"); f.attempt.source_stopped_at = new Date(f.now - 1); f.attempt.checkpoint_object = "fresh-uncertain";
    await f.recovery.run(f.attempt.id);
    expect(f.store.fail).toHaveBeenCalledWith(f.attempt.id, "recovery_capture_unconfirmed", f.attempt.lease_id);
    expect(f.compute.exec).not.toHaveBeenCalled(); expect(f.checkpoints.storage.downloadUrl).not.toHaveBeenCalled();
  });
  it("never delivers restore credentials twice after an unknown restore result", async () => {
    const f = fixture("restoring"); f.attempt.replacement_create = { restoreClaimedAt: new Date(f.now).toISOString() } as never;
    await f.recovery.run(f.attempt.id);
    expect(f.store.fail).toHaveBeenCalledWith(f.attempt.id, "checkpoint_restore_unconfirmed", f.attempt.lease_id);
    expect(f.githubToken).not.toHaveBeenCalled(); expect(f.compute.exec).not.toHaveBeenCalled();
  });
  it("waits for hello after uncertain one-time token delivery without restarting the candidate", async () => {
    const f = fixture("booting"); f.attempt.published_at = new Date(f.now); f.attempt.replacement_create = { bootDeliveredAt: new Date(f.now).toISOString() } as never;
    await f.recovery.run(f.attempt.id);
    expect(f.compute.exec).not.toHaveBeenCalled(); expect(f.store.fail).not.toHaveBeenCalled();
  });
  it("keeps the original until both setup and configured worker readiness are proven", async () => {
    const f = fixture("verifying"); f.attempt.replacement_boot_id = randomUUID();
    await f.recovery.run(f.attempt.id);
    expect(f.store.ready).toHaveBeenCalled(); expect(f.compute.delete).not.toHaveBeenCalled();
  });
  it("leaves the currently owned original VM intact while reconciling a failed attempt", async () => {
    const f = fixture("failed"); f.attempt.completed_at = new Date(f.now - 25 * 60 * 60_000);
    await f.recovery.run(f.attempt.id);
    expect(f.compute.delete).not.toHaveBeenCalled(); expect(f.store.purge).toHaveBeenCalled();
  });

  it("retains the original if Stop wins after candidate publication but before continuity is proven", async () => {
    const f = fixture("failed"); f.attempt.completed_at = new Date(f.now - 25 * 60 * 60_000);
    f.attempt.replacement_sandbox_id = "bx_candidatefixture"; f.attempt.published_at = new Date(f.now - 25 * 60 * 60_000);
    f.store.ownedSandbox.mockImplementation(async sandbox => sandbox === f.attempt.replacement_sandbox_id);
    f.store.sourceDisposable.mockResolvedValue(false);
    await f.recovery.run(f.attempt.id);
    expect(f.compute.delete).not.toHaveBeenCalled();
  });
  it("retains unresolved create receipts instead of deleting an unobserved VM", async () => {
    const f = fixture("cancelled"); f.attempt.completed_at = new Date(f.now - 25 * 60 * 60_000);
    f.attempt.replacement_create = { name: "fixture-recovery", requestedAt: new Date(f.now - 26 * 60 * 60_000).toISOString(), createIssuedAt: new Date(f.now).toISOString() } as never;
    await f.recovery.run(f.attempt.id);
    expect(f.compute.findSandbox).toHaveBeenCalled(); expect(f.store.purge).not.toHaveBeenCalled(); expect(f.compute.delete).not.toHaveBeenCalled();
  });

  it("keeps uncertain uploads past the URL horizon and retains receipts when provider cleanup fails", async () => {
    const f = fixture("failed"); f.attempt.completed_at = new Date(f.now - 25 * 60 * 60_000);
    f.attempt.checkpoint_object = "fresh-uncertain"; f.attempt.checkpoint_upload_until = new Date(f.now + 60_000);
    await f.recovery.run(f.attempt.id);
    expect(f.checkpoints.storage.delete).not.toHaveBeenCalled(); expect(f.store.purge).not.toHaveBeenCalled();
    f.attempt.checkpoint_upload_until = null; f.store.ownedSandbox.mockResolvedValue(false);
    f.compute.delete.mockRejectedValue(new Error("synthetic provider failure"));
    await f.recovery.run(f.attempt.id);
    expect(f.store.deletedSandbox).not.toHaveBeenCalled(); expect(f.store.purge).not.toHaveBeenCalled();
  });
});
