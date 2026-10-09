import { beforeEach, describe, expect, it } from "vitest";
import type { CloudAgentBootConversation } from "@zeros/protocol/cloud-agent-bootstrap";
import { cloudScopedId, cloudWorkspaceKey } from "../../../platform/bridge/cloud-workspace-key";
import { useSessionsStore } from "../sessions-store";

const uuid = (n: number) => `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;
const binding: CloudAgentBootConversation = { version: 1, mode: "boot-owner-v1", fundingScope: "workspace-roles-v1",
  organizationId: uuid(1), workspaceId: uuid(2), generation: 3, engineInstanceId: uuid(3), bootId: uuid(4), writerEpoch: uuid(5),
  fundingOwnerUserId: uuid(6), fundingOwnerEpoch: 2, authorityEpoch: 4, cacheRevision: 1, desiredCacheRevision: 1,
  initialAdoptions: [{ provider: "claude", status: "unknown" }, { provider: "codex", status: "unknown" }, { provider: "cursor", status: "known", adoptionId: uuid(8) }] };
const chatId = cloudScopedId(binding, "chat");
function event(sequence = 1, adoptionId = uuid(8), conversationId = "chat") {
  const { cacheRevision: _cache, desiredCacheRevision: _desired, initialAdoptions: _initial, ...scope } = binding;
  return { use: { version: 1 as const, scope, conversationId, commandId: uuid(20 + sequence), turnId: uuid(30 + sequence), executionId: "warm-execution",
    nativeStage: "native_write" as const, firstUseSequence: sequence, eventSequence: sequence,
    credentialRun: { version: 1 as const, provider: "cursor" as const, bootId: binding.bootId, writerEpoch: binding.writerEpoch,
      fundingOwnerUserId: binding.fundingOwnerUserId, fundingOwnerEpoch: binding.fundingOwnerEpoch, cacheRevision: 1,
      credentialId: uuid(9), credentialRevision: 1, connectionRevision: 1, materialVersion: 1, adoptionId, displayName: "Workspace account" } } };
}
beforeEach(() => useSessionsStore.getState().clearAll());
describe("activated cloud credential-use store", () => {
  it("installs only exact scoped cloud chats and never fabricates a Local binding", () => {
    const store = useSessionsStore.getState();
    expect(store.installCloudAgentBootBinding("local-chat", binding)).toBe(false);
    expect(store.installCloudAgentBootBinding(cloudScopedId({ ...binding, workspaceId: uuid(11) }, "chat"), binding)).toBe(false);
    expect(store.installCloudAgentBootBinding(chatId, binding)).toBe(true);
    expect(useSessionsStore.getState().cloudAgentCredentials[chatId]?.binding).toEqual(binding);
  });
  it("keeps three provider baselines and the real hidden A-B-A predecessor without a mounted chat", () => {
    const store = useSessionsStore.getState(); store.installCloudAgentBootBinding(chatId, binding);
    store.applyCloudAgentCredentialUse(chatId, event(1), binding);
    expect(useSessionsStore.getState().cloudAgentCredentials[chatId]?.state.notice).toBeUndefined();
    store.applyCloudAgentCredentialUse(chatId, event(2, uuid(10)), binding);
    store.applyCloudAgentCredentialUse(chatId, event(3), binding);
    const entry = useSessionsStore.getState().cloudAgentCredentials[chatId]!;
    expect(entry.state.notice?.credentialRun.adoptionId).toBe(uuid(8));
    expect(entry.state.last.cursor?.firstUseSequence).toBe(3);
    expect(useSessionsStore.getState().sessions).toEqual({});
  });
  it.each(["organizationId", "workspaceId", "generation", "engineInstanceId", "bootId", "writerEpoch", "fundingOwnerUserId", "fundingOwnerEpoch", "authorityEpoch"] as const)("ignores a foreign actual-use %s", field => {
    const store = useSessionsStore.getState(); store.installCloudAgentBootBinding(chatId, binding);
    const before = useSessionsStore.getState().cloudAgentCredentials;
    const value = event(); value.use.scope = { ...value.use.scope, [field]: typeof binding[field] === "number" ? Number(binding[field]) + 1 : uuid(99) };
    expect(store.applyCloudAgentCredentialUse(chatId, value, binding)).toBe(false);
    expect(useSessionsStore.getState().cloudAgentCredentials).toBe(before);
  });
  it("preserves original first-use order through a late ACK for a previous warm turn", () => {
    const store = useSessionsStore.getState(); store.installCloudAgentBootBinding(chatId, binding);
    store.applyCloudAgentCredentialUse(chatId, event(1), binding); store.applyCloudAgentCredentialUse(chatId, event(2, uuid(10)), binding);
    const late = { use: { ...event(1).use, nativeStage: "native_acceptance_ack", eventSequence: 3 } };
    store.applyCloudAgentCredentialUse(chatId, late, binding);
    expect(useSessionsStore.getState().cloudAgentCredentials[chatId]?.state.last.cursor?.adoptionId).toBe(uuid(10));
    expect(useSessionsStore.getState().cloudAgentCredentials[chatId]?.state.notice?.credentialRun.adoptionId).toBe(uuid(10));
  });
  it("refuses a delivery cursor as a newly invented first-use order", () => {
    const store = useSessionsStore.getState(); store.installCloudAgentBootBinding(chatId, binding);
    const forged = { use: { ...event().use, firstUseSequence: 2, eventSequence: 1 } };
    expect(store.applyCloudAgentCredentialUse(chatId, forged, binding)).toBe(false);
  });
  it("does not change baseline from cache selection, label or material rotation", () => {
    const store = useSessionsStore.getState(); store.installCloudAgentBootBinding(chatId, binding);
    const cached = { ...binding, cacheRevision: 2, desiredCacheRevision: 2 };
    store.installCloudAgentBootBinding(chatId, cached);
    expect(useSessionsStore.getState().cloudAgentCredentials[chatId]?.state.last).toEqual({});
    store.applyCloudAgentCredentialUse(chatId, event(), cached);
    store.applyCloudAgentCredentialUse(chatId, { use: { ...event(2).use, credentialRun: { ...event(2).use.credentialRun,
      materialVersion: 2, displayName: "Renamed", credentialRevision: 2 } } }, cached);
    expect(useSessionsStore.getState().cloudAgentCredentials[chatId]?.state.notice).toBeUndefined();
  });
  it("replaces state only from the current binding and rejects an old boot event before it can restore state", () => {
    const store = useSessionsStore.getState(); store.installCloudAgentBootBinding(chatId, binding);
    store.applyCloudAgentCredentialUse(chatId, event(), binding);
    const replacement = { ...binding, bootId: uuid(44), writerEpoch: uuid(45) };
    store.installCloudAgentBootBinding(chatId, replacement);
    expect(store.applyCloudAgentCredentialUse(chatId, event(2, uuid(10)), replacement)).toBe(false);
    expect(useSessionsStore.getState().cloudAgentCredentials[chatId]?.binding).toEqual(replacement);
    expect(useSessionsStore.getState().cloudAgentCredentials[chatId]?.state.last).toEqual({});
  });
  it("restores a bounded two-use-per-provider snapshot without using receipts or changing original order", () => {
    const store = useSessionsStore.getState();
    expect(store.installCloudAgentCredentialUses(chatId, binding, [event(2, uuid(10)).use, event(3).use])).toBe(true);
    expect(useSessionsStore.getState().cloudAgentCredentials[chatId]?.state.notice?.credentialRun.adoptionId).toBe(uuid(8));
    const before = useSessionsStore.getState().cloudAgentCredentials;
    expect(store.installCloudAgentCredentialUses(chatId, binding, Array.from({ length: 7 }, (_, i) => event(i + 10).use))).toBe(false);
    expect(useSessionsStore.getState().cloudAgentCredentials).toBe(before);
  });
  it("orders recovered original uses independently of a delayed prior-turn ACK delivery", () => {
    const store = useSessionsStore.getState();
    const prior = { ...event(2, uuid(10)).use, nativeStage: "native_acceptance_ack", eventSequence: 4 };
    expect(store.installCloudAgentCredentialUses(chatId, binding, [prior, event(3).use])).toBe(true);
    const entry = useSessionsStore.getState().cloudAgentCredentials[chatId]!;
    expect(entry.state.last.cursor?.adoptionId).toBe(uuid(8));
    expect(entry.state.notice?.credentialRun.adoptionId).toBe(uuid(8));
    expect(entry.state.eventSequence).toBe(4);
  });
  it("keeps a newer live notice when recovering an older use from another provider", () => {
    const store = useSessionsStore.getState(); store.installCloudAgentBootBinding(chatId, binding);
    store.applyCloudAgentCredentialUse(chatId, event(5, uuid(10)), binding);
    const old = { ...event(2).use, credentialRun: { ...event(2).use.credentialRun, provider: "codex" as const } };
    const known = { ...binding, initialAdoptions: binding.initialAdoptions.map(value => value.provider === "codex" ?
      { provider: "codex" as const, status: "known" as const, adoptionId: uuid(10) } : value) };
    store.clearAll(); store.installCloudAgentBootBinding(chatId, known);
    store.applyCloudAgentCredentialUse(chatId, event(5, uuid(10)), known);
    store.installCloudAgentCredentialUses(chatId, known, [old]);
    const entry = useSessionsStore.getState().cloudAgentCredentials[chatId]!;
    expect(entry.state.last.codex?.firstUseSequence).toBe(2);
    expect(entry.state.notice?.firstUseSequence).toBe(5);
    expect(entry.state.eventSequence).toBe(5);
  });
  it("refuses contradictory original-use cursors across recovered providers", () => {
    const store = useSessionsStore.getState();
    const foreign = { ...event(2).use, credentialRun: { ...event(2).use.credentialRun, provider: "codex" as const } };
    expect(store.installCloudAgentCredentialUses(chatId, binding, [event(2, uuid(10)).use, foreign])).toBe(false);
    expect(useSessionsStore.getState().cloudAgentCredentials[chatId]).toBeUndefined();
  });
  it("prunes an unmounted chat and clears exact state on account retirement", () => {
    const store = useSessionsStore.getState(); store.installCloudAgentBootBinding(chatId, binding);
    store.removeSession(chatId); expect(useSessionsStore.getState().cloudAgentCredentials[chatId]).toBeUndefined();
    store.installCloudAgentBootBinding(chatId, binding); store.clearAll(); expect(useSessionsStore.getState().cloudAgentCredentials).toEqual({});
    expect(cloudWorkspaceKey(binding)).toContain(binding.organizationId);
  });
});
