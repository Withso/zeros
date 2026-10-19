import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createRuntimeRollbackConversation } from "./runtime-rollback-runner.js";
import { parseRuntimeRollbackOffer, type RuntimeRollbackOffer } from "./runtime-rollback-contract.js";
import { transferActive } from "./runtime-transfer-proof.test-fixtures.js";

function fixture() {
  const now = Date.now();
  const scope = { workspaceId: randomUUID(), organizationId: randomUUID(), generation: 2,
    providerResourceId: "bx_fixture", authorityEpoch: "8", intentId: randomUUID() };
  const input = { schema: "zeros.runtime-rollback-cache/v1" as const, operation: "evict" as const,
    fence: randomUUID(), scope, current: transferActive, expiresAt: new Date(now + 60_000).toISOString() };
  const runtime = { runtimeId: `r1-${"3".repeat(64)}`, manifestSha256: "3".repeat(64),
    archiveSha256: "4".repeat(64), archiveBytes: 100, expandedBytes: 200, sourceCommit: "5".repeat(40),
    nodeModulesAbi: 127, bootstrapProtocolVersion: 1 as const, engineProtocolVersion: 1 };
  const receipt = Buffer.from(JSON.stringify({ schema: "zeros.runtime-install-receipt/v1",
    runtimeId: runtime.runtimeId, manifestSha256: runtime.manifestSha256, archiveSha256: runtime.archiveSha256,
    baseCompatibilityId: input.current.baseCompatibilityId, bootstrapVersion: 1, expandedBytes: 200,
    fileCount: 2, installedAt: "2026-10-01T00:00:00Z" }) + "\n");
  const offer = { runtime, baseCompatibilityId: input.current.baseCompatibilityId, scope,
    currentRuntimeId: input.current.runtimeId, bootId: input.current.bootId, diskEpoch: 3,
    installerReceipt: receipt.toString("base64url"), installerReceiptSha256: createHash("sha256").update(receipt).digest("hex") };
  const retentionId = randomUUID();
  const handlers = { retain: vi.fn(async (_offer: RuntimeRollbackOffer) => retentionId), authorize: vi.fn(async () => true) };
  const dialog = createRuntimeRollbackConversation(input, handlers, () => now);
  const frame = (phase: string, extra = {}) => JSON.stringify({ schema: input.schema, fence: input.fence, scope,
    phase, ...extra });
  const result = (outcome: string) => JSON.stringify({ schema: input.schema, fence: input.fence, scope,
    outcome, ...(outcome === "evicted" ? { retentionId } : {}) });
  return { input, offer, retentionId, handlers, dialog, frame, result, receipt };
}

describe("sealed-stop rollback retention conversation", () => {
  it("keeps exact receipt bytes and orders durable retention before retirement and eviction", async () => {
    const f = fixture();
    expect(parseRuntimeRollbackOffer(f.offer)).toEqual(f.offer);
    expect(JSON.parse((await f.dialog.onFrame(f.frame("retain", { offer: f.offer })))!))
      .toMatchObject({ allow: true, retentionId: f.retentionId });
    expect(f.handlers.authorize).not.toHaveBeenCalled();
    for (const phase of ["retire_authorized", "evict_authorized"])
      expect(JSON.parse((await f.dialog.onFrame(f.frame(phase)))!)).toMatchObject({ allow: true });
    await f.dialog.onFrame(f.result("evicted"));
    expect(f.dialog.result()).toMatchObject({ outcome: "evicted", retentionId: f.retentionId });
    expect(f.handlers.retain.mock.calls[0]![0]).toEqual(f.offer);
  });

  it("denies lost retention ACK without authorizing retirement", async () => {
    const f = fixture();
    f.handlers.retain.mockRejectedValue(new Error("private transport text"));
    expect(JSON.parse((await f.dialog.onFrame(f.frame("retain", { offer: f.offer })))!)).toMatchObject({ allow: false });
    await expect(f.dialog.onFrame(f.frame("retire_authorized"))).rejects.toThrow("Runtime rollback response is invalid");
    expect(f.handlers.authorize).not.toHaveBeenCalled();
  });

  it.each(["foreign scope", "wrong current", "wrong base", "wrong boot", "altered receipt", "altered descriptor"])("refuses %s before retention", async change => {
    const f = fixture(), offer = structuredClone(f.offer);
    if (change === "foreign scope") offer.scope.organizationId = randomUUID();
    if (change === "wrong current") offer.currentRuntimeId = offer.runtime.runtimeId;
    if (change === "wrong base") offer.baseCompatibilityId = `bc1-${"1".repeat(64)}`;
    if (change === "wrong boot") offer.bootId = randomUUID();
    if (change === "altered receipt") offer.installerReceiptSha256 = "0".repeat(64);
    if (change === "altered descriptor") offer.runtime.archiveSha256 = "0".repeat(64);
    await expect(f.dialog.onFrame(f.frame("retain", { offer }))).rejects.toThrow();
    expect(f.handlers.retain).not.toHaveBeenCalled();
  });

  it("refuses an eviction result without the final authority check and refuses frame replay", async () => {
    const f = fixture();
    await f.dialog.onFrame(f.frame("retain", { offer: f.offer }));
    await expect(f.dialog.onFrame(f.result("evicted"))).rejects.toThrow();
    await expect(f.dialog.onFrame(f.frame("retain", { offer: f.offer }))).rejects.toThrow();
    expect(f.handlers.retain).toHaveBeenCalledOnce();
  });

  it("accepts absence of a previous payload without a retention write", async () => {
    const f = fixture();
    await f.dialog.onFrame(f.result("unchanged"));
    expect(f.dialog.result()).toMatchObject({ outcome: "unchanged" });
    expect(f.handlers.retain).not.toHaveBeenCalled();
  });
});
