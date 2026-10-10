import { describe, expect, it } from "vitest";
import type { CloudAgentInitialAdoption } from "@zeros/protocol/cloud-agent-bootstrap";
import { applyCloudAgentCredentialUse, cloudAgentCredentialNoticeState,
  type CloudAgentCredentialUse, type CloudAgentCredentialNoticeContext } from "../cloud-agent-credential-notice";

const ids = Array.from({ length: 12 }, (_, i) => `${String(i + 1).padStart(8, "0")}-1111-4111-8111-111111111111`);
const context: CloudAgentCredentialNoticeContext = { conversationId: "chat", binding: {
  organizationId: ids[0], workspaceId: ids[1], generation: 3, engineInstanceId: ids[2], bootId: ids[3], writerEpoch: ids[4],
  fundingOwnerUserId: ids[5], fundingOwnerEpoch: 1, mode: "boot-owner-v1", fundingScope: "workspace-roles-v1" } };
function initial(value: CloudAgentInitialAdoption): CloudAgentInitialAdoption[] {
  return [{ provider: "claude", status: "unknown" }, { provider: "codex", status: "unknown" }, value];
}
function use(sequence = 1, adoptionId = ids[6]): CloudAgentCredentialUse {
  return { version: 1, scope: { organizationId: ids[0], workspaceId: ids[1], generation: 3, engineInstanceId: ids[2], bootId: ids[3], writerEpoch: ids[4], fundingOwnerUserId: ids[5], fundingOwnerEpoch: 1 }, conversationId: "chat", commandId: ids[7], turnId: `turn-${sequence}`,
    executionId: `execution-${sequence}`, eventSequence: sequence, firstUseSequence: sequence, nativeStage: "native_write", credentialRun: {
      version: 1, bootId: ids[3], writerEpoch: ids[4], cacheRevision: 1, provider: "cursor", fundingOwnerUserId: ids[5],
      fundingOwnerEpoch: 1, credentialId: ids[8], credentialRevision: 1, connectionRevision: 1,
      adoptionId, materialVersion: 1, displayName: "Synthetic account" } };
}

describe("actual cloud credential adoption notice", () => {
  it("keeps original first-use ordering when a prior warm run ACK is delivered after a newer adoption", () => {
    const a = { ...use(1), executionId: "same-warm-execution", firstUseSequence: 1 };
    const b = { ...use(2, ids[9]), executionId: "same-warm-execution", firstUseSequence: 2 };
    let state = applyCloudAgentCredentialUse(cloudAgentCredentialNoticeState(context), context, a);
    state = applyCloudAgentCredentialUse(state, context, b);
    const oldAck = { ...a, eventSequence: 3, nativeStage: "native_acceptance_ack" as const };
    const after = applyCloudAgentCredentialUse(state, context, oldAck);
    expect(after.last).toBe(state.last); expect(after.notice).toBe(state.notice);
    const realNextA = { ...use(4), executionId: "same-warm-execution", firstUseSequence: 4 };
    expect(applyCloudAgentCredentialUse(after, context, realNextA).notice?.credentialRun.adoptionId).toBe(ids[6]);
  });
  it("refuses absent/unsafe first-use evidence and same-order contradictory native identity", () => {
    const first = use(), state = applyCloudAgentCredentialUse(cloudAgentCredentialNoticeState(context), context, first);
    for (const firstUseSequence of [undefined, 0, 3, Number.MAX_SAFE_INTEGER + 1]) {
      const malformed = { ...use(2, ids[9]), firstUseSequence } as CloudAgentCredentialUse;
      expect(applyCloudAgentCredentialUse(state, context, malformed)).toBe(state);
    }
    const contradictory = { ...first, eventSequence: 2, turnId: "other" };
    expect(applyCloudAgentCredentialUse(state, context, contradictory)).toBe(state);
    const changedMaterialIdentity = { ...first, eventSequence: 2, credentialRun: { ...first.credentialRun, adoptionId: ids[9] } };
    expect(applyCloudAgentCredentialUse(state, context, changedMaterialIdentity)).toBe(state);
  });
  it.each(["absent", "unknown", "known-same"] as const)("uses a silent initial baseline for %s metadata", kind => {
    const current = { ...context, ...(kind === "absent" ? {} : { initialAdoptions: initial(kind === "unknown"
      ? { provider: "cursor", status: "unknown" } : { provider: "cursor", status: "known", adoptionId: ids[6] }) }) };
    const state = applyCloudAgentCredentialUse(cloudAgentCredentialNoticeState(current), current, use());
    expect(state.last.cursor?.adoptionId).toBe(ids[6]); expect(state.notice).toBeUndefined();
  });

  it.each(["missing", "known-replaced"] as const)("announces %s before the first actual native use", kind => {
    const current = { ...context, initialAdoptions: initial(kind === "missing" ? { provider: "cursor", status: "missing" }
      : { provider: "cursor", status: "known", adoptionId: ids[9] }) };
    const event = use(), state = applyCloudAgentCredentialUse(cloudAgentCredentialNoticeState(current), current, event);
    expect(state.notice).toEqual(event);
  });

  it("announces A->B->A only from actually-used identities, preserving per-provider baselines", () => {
    let state = applyCloudAgentCredentialUse(cloudAgentCredentialNoticeState(context), context, use());
    state = applyCloudAgentCredentialUse(state, context, use(2, ids[9])); expect(state.notice?.credentialRun.adoptionId).toBe(ids[9]);
    state = applyCloudAgentCredentialUse(state, context, use(3)); expect(state.notice?.credentialRun.adoptionId).toBe(ids[6]);
    const codex = use(4, ids[10]); codex.credentialRun.provider = "codex";
    state = applyCloudAgentCredentialUse(state, context, codex);
    expect(state.last.cursor?.adoptionId).toBe(ids[6]); expect(state.last.codex?.adoptionId).toBe(ids[10]);
    expect(state.notice?.credentialRun.provider).toBe("cursor");
  });

  it("keeps token/model-policy/label-only revisions silent", () => {
    const first = applyCloudAgentCredentialUse(cloudAgentCredentialNoticeState(context), context, use());
    const rotated = use(2); Object.assign(rotated.credentialRun, { materialVersion: 2, cacheRevision: 4,
      credentialRevision: 2, connectionRevision: 2, displayName: "Renamed account" });
    const next = applyCloudAgentCredentialUse(first, context, rotated);
    expect(next.notice).toBeUndefined(); expect(next.last.cursor?.adoptionId).toBe(ids[6]);
  });

  it.each(["organizationId", "workspaceId", "generation", "engineInstanceId", "bootId", "writerEpoch", "fundingOwnerUserId", "fundingOwnerEpoch"] as const)(
    "ignores an old/foreign %s actual-use event without changing baseline", field => {
      const state = cloudAgentCredentialNoticeState(context), event = use();
      if (field === "generation" || field === "fundingOwnerEpoch") event.scope[field] += 1; else event.scope[field] = ids[11];
      expect(applyCloudAgentCredentialUse(state, context, event)).toBe(state);
    });

  it("keeps old conversation/current-binding, delayed frames and duplicate native callbacks inert", () => {
    const first = applyCloudAgentCredentialUse(cloudAgentCredentialNoticeState(context), context, use(2));
    expect(applyCloudAgentCredentialUse(first, context, use(1, ids[9]))).toBe(first);
    const duplicate = use(2); Object.assign(duplicate, { eventSequence: 3 });
    const afterDuplicate = applyCloudAgentCredentialUse(first, context, duplicate);
    expect(afterDuplicate.last).toBe(first.last); expect(afterDuplicate.notice).toBe(first.notice);
    expect(afterDuplicate.eventSequence).toBe(3);
    expect(applyCloudAgentCredentialUse(afterDuplicate, context, use(3, ids[9]))).toBe(afterDuplicate);
    const foreign = use(3, ids[9]); Object.assign(foreign, { conversationId: "other" });
    expect(applyCloudAgentCredentialUse(first, context, foreign)).toBe(first);
    const changed = { ...context, binding: { ...context.binding, bootId: ids[11] } };
    expect(applyCloudAgentCredentialUse(first, changed, use(3, ids[9]))).toBe(first);
  });

  it("refuses audit/cache/pending-bootstrap stages and inconsistent captured credential scope", () => {
    const first = cloudAgentCredentialNoticeState(context);
    const audit = { ...use(), nativeStage: "dispatch_committed" } as unknown as CloudAgentCredentialUse;
    expect(applyCloudAgentCredentialUse(first, context, audit)).toBe(first);
    const wrong = use(); wrong.credentialRun.bootId = ids[11];
    expect(applyCloudAgentCredentialUse(first, context, wrong)).toBe(first);
  });

  it.each(["provider", "version"] as const)("refuses malformed actual-use %s without growing provider state", field => {
    const first = cloudAgentCredentialNoticeState(context);
    const event = use();
    Object.assign(event.credentialRun, { [field]: field === "provider" ? "foreign-provider" : 2 });
    expect(applyCloudAgentCredentialUse(first, context, event)).toBe(first);
    expect(Object.keys(first.last)).toHaveLength(0);
  });

  it("captures immutable nonsecret initial adoption and native-use presentation snapshots", () => {
    const baseline = initial({ provider: "cursor", status: "missing" });
    const current = { ...context, binding: { ...context.binding }, initialAdoptions: baseline };
    const state = cloudAgentCredentialNoticeState(current);
    baseline[2] = { provider: "cursor", status: "unknown" };
    const event = use(), next = applyCloudAgentCredentialUse(state, current, event);
    event.credentialRun.displayName = "Late mutation";
    expect(next.notice?.credentialRun.displayName).toBe("Synthetic account");
    expect(next.initial.cursor.status).toBe("missing"); expect(Object.keys(next.last)).toHaveLength(1);
  });
});
