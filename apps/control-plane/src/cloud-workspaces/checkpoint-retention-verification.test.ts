import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  verifyStoppedWorkspaceCheckpoint,
  type StoppedCheckpointSnapshot,
} from "./checkpoint-retention-verification.js";

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function fixture(finalCheckpoint = true) {
  const manifest = Buffer.from("synthetic manifest"), artifact = Buffer.from("synthetic native artifact");
  const blobs = [manifest, artifact].map(bytes => ({ id: randomUUID(), sha256: sha(bytes), sizeBytes: bytes.length }));
  const snapshot: StoppedCheckpointSnapshot = {
    workspaceId: randomUUID(), organizationId: randomUUID(), generation: 2,
    authorityEpoch: "7", version: "9", ownerUserId: randomUUID(), status: "stopped",
    currentContentRevision: "11", currentRecordRevision: "3",
    checkpointId: randomUUID(), checkpointGeneration: 2, checkpointAt: "2026-01-01T00:00:00.000Z",
    integritySha256: sha(manifest), manifestBlobId: blobs[0]!.id, finalCheckpoint, blobs,
  };
  const buffers: Buffer[] = [];
  const readSnapshot = vi.fn(async () => structuredClone(snapshot));
  const readBlob = vi.fn(async (blobId: string) => {
    const result = Buffer.from(blobId === snapshot.blobs[0]!.id ? manifest : artifact);
    buffers.push(result); return result;
  });
  return { snapshot, readSnapshot, readBlob, buffers };
}
afterEach(() => vi.useRealTimers());

describe("stopped checkpoint verification before provider expiry", () => {
  it("plans without reading payloads or claiming byte verification", async () => {
    const f = fixture();
    const result = await verifyStoppedWorkspaceCheckpoint(f, { verify: false });
    expect(result.state).toBe("planned");
    expect(result.verifiedAt).toBeNull();
    expect(f.readBlob).not.toHaveBeenCalled();
  });

  it("verifies every object and the final fence without returning any payload", async () => {
    const f = fixture();
    const result = await verifyStoppedWorkspaceCheckpoint(f, { verify: true });
    expect(result).toMatchObject({ state: "verified", coverage: "final_checkpoint", blobCount: 2 });
    expect(result.verifiedAt).not.toBeNull();
    expect(f.readSnapshot).toHaveBeenCalledTimes(2);
    expect(f.readBlob.mock.calls.map(call => call[0])).toEqual(f.snapshot.blobs.map(blob => blob.id));
    expect(JSON.stringify(result)).not.toContain("synthetic");
    expect(f.buffers.every(bytes => bytes.every(byte => byte === 0))).toBe(true);
  });

  it("keeps a periodic checkpoint distinct from a final capture", async () => {
    const f = fixture(false);
    const result = await verifyStoppedWorkspaceCheckpoint(f, { verify: true });
    expect(result.coverage).toBe("checkpoint_only");
    expect(result.state).toBe("verified");
  });

  it("requires the manifest object to match the checkpoint's integrity digest", async () => {
    const f = fixture(); f.snapshot.integritySha256 = "f".repeat(64);
    await expect(verifyStoppedWorkspaceCheckpoint(f, { verify: true })).rejects.toMatchObject({ code: "checkpoint_integrity_failed" });
    expect(f.readBlob).not.toHaveBeenCalled();
  });

  it.each(["same-size corruption", "truncated object"])("refuses %s even when metadata said available", async change => {
    const f = fixture();
    f.readBlob.mockImplementationOnce(async () => {
      const bytes = Buffer.alloc(change === "same-size corruption" ? f.snapshot.blobs[0]!.sizeBytes : 1);
      f.buffers.push(bytes); return bytes;
    });
    await expect(verifyStoppedWorkspaceCheckpoint(f, { verify: true })).rejects.toMatchObject({ code: "checkpoint_integrity_failed" });
    expect(f.buffers.every(bytes => bytes.every(byte => byte === 0))).toBe(true);
    expect(f.readSnapshot).toHaveBeenCalledTimes(1);
  });

  it.each(["generation", "ownerUserId", "authorityEpoch", "checkpointId", "status"] as const)(
    "refuses a changed %s after object reads", async field => {
      const f = fixture();
      f.readSnapshot.mockResolvedValueOnce(structuredClone(f.snapshot));
      f.readSnapshot.mockImplementationOnce(async () => ({ ...structuredClone(f.snapshot),
        [field]: field === "generation" ? 3 : field === "status" ? "starting" : randomUUID() }));
      await expect(verifyStoppedWorkspaceCheckpoint(f, { verify: true })).rejects.toMatchObject({ code: "checkpoint_verification_changed" });
    },
  );

  it("requires the complete original blob set again before reporting success", async () => {
    const f = fixture();
    f.readSnapshot.mockResolvedValueOnce(structuredClone(f.snapshot));
    f.readSnapshot.mockImplementationOnce(async () => ({ ...structuredClone(f.snapshot), blobs: f.snapshot.blobs.slice(0, 1) }));
    await expect(verifyStoppedWorkspaceCheckpoint(f, { verify: true })).rejects.toMatchObject({ code: "checkpoint_verification_changed" });
  });

  it("bounds object count and total bytes before reading payloads", async () => {
    const f = fixture();
    for (const limits of [{ maxBlobs: 1 }, { maxBytes: 1 }]) {
      await expect(verifyStoppedWorkspaceCheckpoint(f, { verify: true, ...limits }))
        .rejects.toMatchObject({ code: "checkpoint_verification_limit" });
    }
    expect(f.readBlob).not.toHaveBeenCalled();
  });

  it("ends a stalled read at the fixed deadline and wipes a late reply", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let finish!: (bytes: Buffer) => void;
    f.readBlob.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const failed = expect(verifyStoppedWorkspaceCheckpoint(f, { verify: true, timeoutMs: 1_000 }))
      .rejects.toMatchObject({ code: "checkpoint_verification_timeout" });
    await vi.advanceTimersByTimeAsync(1_000);
    await failed;
    const late = Buffer.from("late private response"); finish(late);
    await vi.advanceTimersByTimeAsync(0);
    expect(late.every(byte => byte === 0)).toBe(true);
    expect(f.readSnapshot).toHaveBeenCalledTimes(1);
  });

  it("does not expose an object-store error body", async () => {
    const f = fixture();
    f.readBlob.mockRejectedValueOnce(new Error("fixture-private-provider-error"));
    await expect(verifyStoppedWorkspaceCheckpoint(f, { verify: true })).rejects.toMatchObject({
      code: "checkpoint_object_unavailable", message: "Checkpoint objects could not be verified",
    });
  });
});
