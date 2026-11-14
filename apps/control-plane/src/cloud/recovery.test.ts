import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CloudRecovery } from "./recovery.js";
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
