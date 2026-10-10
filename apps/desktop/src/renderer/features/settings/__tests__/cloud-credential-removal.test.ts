import { beforeEach, describe, expect, it, vi } from "vitest";
const request = vi.hoisted(() => vi.fn());
vi.mock("../../../platform/cloud-workspaces", () => ({ cloudAccountRequest: request }));
import { acceptCloudCredentialRemovalOutcome, beginCloudCredentialRemoval, cloudCredentialRemovalNeedsConfirmation,
  cloudCredentialRemovalOutcomeSchema, cloudCredentialRemovalTargetSchema, decideCloudCredentialRemoval, decideCloudCredentialRemovalState,
  leaveCloudCredentialRemoval, prepareCloudCredentialRemoval, readCloudCredentialRemoval, type CloudCredentialRemovalTarget } from "../cloud-credential-removal";
const ids = Array.from({ length: 5 }, (_, i) => `${String(i + 1).padStart(8,"0")}-1111-4111-8111-111111111111`);
const targets: CloudCredentialRemovalTarget[] = [
  { kind: "remove-organization-credential", organizationId: ids[1], credentialId: ids[2], expectedCredentialRevision: 1 },
  { kind: "revoke-credential", credentialId: ids[2], expectedCredentialRevision: 1 },
  { kind: "disconnect-provider", organizationId: ids[1], provider: "cursor", expectedConnectionRevision: 2 },
  ...(["local", "organization", "global"] as const).map(scope => ({ kind: "remove-dev-reference" as const, organizationId: ids[1], referenceId: ids[2], scope, expectedCredentialRevision: 1 })),
];
function outcome(state: "removed" | "cancelled" | "expired" | "awaiting-confirmation" | "pending", revision = 1) {
  return { version: 1, operationId: ids[0], revision, state, ...(state === "awaiting-confirmation" ? { confirmedRunning: true, expiresAt: "2026-10-08T17:00:00Z" } : {}), ...(state === "pending" ? { phase: "preparing", retryAfterMs: 100 } : {}) };
}
beforeEach(() => {
  request.mockReset().mockImplementation(async (_path, schema) => schema.parse(outcome("removed")));
});
describe("conditional cloud credential removal", () => {
  it.each(targets)("preserves the exact $kind scope and stable operation identity", async target => {
    await prepareCloudCredentialRemoval(ids[0], target);
    expect(request).toHaveBeenCalledExactlyOnceWith("/v1/cloud-agent-credentials/removals/prepare", expect.anything(),
      { body: { version: 1, operationId: ids[0], target }, idempotencyKey: ids[0] });
  });
  it("reads passive status and retries the exact Yes identity after an unknown ACK", async () => {
    request.mockRejectedValueOnce(new Error("Synthetic lost ACK"));
    const input = { requestId: ids[3], expectedRevision: 2 };
    await expect(decideCloudCredentialRemoval(ids[0], "confirm", input)).rejects.toThrow("lost ACK");
    await decideCloudCredentialRemoval(ids[0], "confirm", input);
    expect([request.mock.calls[0][0], request.mock.calls[0][2]]).toEqual([request.mock.calls[1][0], request.mock.calls[1][2]]);
    await readCloudCredentialRemoval(ids[0]);
    expect(request).toHaveBeenLastCalledWith(`/v1/cloud-agent-credentials/removals/${ids[0]}`, expect.anything());
  });
  it("rejects an unrelated returned operation before installation", async () => {
    request.mockImplementationOnce(async (_path, schema) => schema.parse({ ...outcome("removed"), operationId: ids[4] }));
    await expect(prepareCloudCredentialRemoval(ids[0], targets[0])).rejects.toThrow();
  });
  it("refuses renderer actor/boot/count selectors and invalid source revisions without a request", () => {
    const hostile = { ...targets[0], actorUserId: ids[4] };
    expect(() => prepareCloudCredentialRemoval(ids[0], hostile)).toThrow();
    expect(() => prepareCloudCredentialRemoval(ids[0], { ...targets[0], expectedCredentialRevision: 0 } as CloudCredentialRemovalTarget)).toThrow();
    expect(request).not.toHaveBeenCalled();
    expect(cloudCredentialRemovalTargetSchema.safeParse({ ...targets[0], bootId: ids[4] }).success).toBe(false);
  });
  it.each(["pending", "removed", "cancelled", "expired"] as const)("does not infer running agents from %s", name => {
    const state = acceptCloudCredentialRemovalOutcome(beginCloudCredentialRemoval(ids[0], targets[0]), outcome(name));
    expect(cloudCredentialRemovalNeedsConfirmation(state)).toBe(false);
    expect(decideCloudCredentialRemovalState(state, "confirm", ids[3])).toBe(state);
  });
  it.each(["removing", "cancelling"] as const)("never creates a new cleanup decision for committed pending %s", phase => {
    const state = acceptCloudCredentialRemovalOutcome(beginCloudCredentialRemoval(ids[0], targets[0]), { ...outcome("pending"), phase });
    expect(leaveCloudCredentialRemoval(state, ids[3])).toBe(state);
  });
  it.each(["removing", "cancelling"] as const)("does not reinterpret an authoritative %s winner from later conflicting responses", phase => {
    const state = acceptCloudCredentialRemovalOutcome(beginCloudCredentialRemoval(ids[0], targets[0]), { ...outcome("pending", 2), phase });
    const invalid = phase === "removing" ? [outcome("cancelled", 3), outcome("expired", 3), outcome("pending", 3)] :
      [outcome("removed", 3), outcome("awaiting-confirmation", 3), { ...outcome("pending", 3), phase: "removing" }];
    for (const incoming of invalid) expect(() => acceptCloudCredentialRemovalOutcome(state, incoming)).toThrow();
    expect(state.outcome).toEqual({ ...outcome("pending", 2), phase });
  });
  it("shows confirmation only after the exact CP confirmed-running outcome", () => {
    const state = acceptCloudCredentialRemovalOutcome(beginCloudCredentialRemoval(ids[0], targets[0]), outcome("awaiting-confirmation"));
    expect(cloudCredentialRemovalNeedsConfirmation(state)).toBe(true);
    expect(cloudCredentialRemovalOutcomeSchema.safeParse({ ...outcome("awaiting-confirmation"), confirmedRunning: false }).success).toBe(false);
    expect(cloudCredentialRemovalOutcomeSchema.safeParse({ ...outcome("pending"), activityCount: 1 }).success).toBe(false);
  });
  it("never cancels a submitted Yes on unmount, unknown ACK, expiry or a later No", () => {
    let state = acceptCloudCredentialRemovalOutcome(beginCloudCredentialRemoval(ids[0], targets[0]), outcome("awaiting-confirmation", 2));
    state = decideCloudCredentialRemovalState(state, "confirm", ids[3]);
    expect(cloudCredentialRemovalNeedsConfirmation(state)).toBe(false);
    expect(state.decision).toEqual({ action: "confirm", requestId: ids[3], expectedRevision: 2 });
    expect(leaveCloudCredentialRemoval(state, ids[4])).toBe(state);
    state = acceptCloudCredentialRemovalOutcome(state, { ...outcome("pending", 3), phase: "removing" });
    expect(leaveCloudCredentialRemoval(state, ids[4])).toBe(state);
    expect(decideCloudCredentialRemovalState(state, "cancel", ids[4])).toBe(state);
  });
  it("keeps an undecided No stable during preparation and preserves first-wins server outcome", () => {
    let state = acceptCloudCredentialRemovalOutcome(beginCloudCredentialRemoval(ids[0], targets[0]), outcome("pending"));
    state = leaveCloudCredentialRemoval(state, ids[3]);
    expect(state.decision?.action).toBe("cancel");
    expect(decideCloudCredentialRemovalState(state, "confirm", ids[4])).toBe(state);
    state = acceptCloudCredentialRemovalOutcome(state, outcome("removed", 2));
    expect(state.outcome?.state).toBe("removed");
  });
  it("does not regress or alter a confirmed terminal and ignores old preparing replies", () => {
    let state = acceptCloudCredentialRemovalOutcome(beginCloudCredentialRemoval(ids[0], targets[0]), outcome("pending", 2));
    expect(acceptCloudCredentialRemovalOutcome(state, outcome("pending"))).toBe(state);
    state = acceptCloudCredentialRemovalOutcome(state, outcome("expired", 3));
    expect(acceptCloudCredentialRemovalOutcome(state, outcome("expired", 3))).toBe(state);
    expect(() => acceptCloudCredentialRemovalOutcome(state, outcome("removed", 4))).toThrow();
  });
});
