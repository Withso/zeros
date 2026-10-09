import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudAgentBootConversation } from "@zeros/protocol/cloud-agent-bootstrap";
import { cloudScopedId, cloudWorkspaceKey } from "../../../platform/bridge/cloud-workspace-key";
import { useSessionsStore } from "../sessions-store";
import { wireCloudAgentCredentialState } from "../cloud-agent-credential-selectors";

const uuid = (n: number) => `${String(n).padStart(8,"0")}-1111-4111-8111-111111111111`;
const binding: CloudAgentBootConversation = { version: 1, mode: "boot-owner-v1", fundingScope: "workspace-roles-v1",
  organizationId: uuid(1), workspaceId: uuid(2), generation: 1, engineInstanceId: uuid(3), bootId: uuid(4), writerEpoch: uuid(5),
  fundingOwnerUserId: uuid(6), fundingOwnerEpoch: 1, authorityEpoch: 2, cacheRevision: 1, desiredCacheRevision: 1,
  initialAdoptions: [{ provider: "claude", status: "missing" }, { provider: "codex", status: "unknown" }, { provider: "cursor", status: "unknown" }] };
function use(sequence = 1) {
  const { cacheRevision: _cache, desiredCacheRevision: _desired, initialAdoptions: _initial, ...scope } = binding;
  return { version: 1 as const, scope, conversationId: "chat", commandId: uuid(10 + sequence), turnId: uuid(20 + sequence), executionId: "execution",
    nativeStage: "sdk_run_created" as const, firstUseSequence: sequence, eventSequence: sequence,
    credentialRun: { version: 1 as const, provider: "claude" as const, bootId: binding.bootId, writerEpoch: binding.writerEpoch,
      fundingOwnerUserId: binding.fundingOwnerUserId, fundingOwnerEpoch: 1, cacheRevision: 1, credentialId: uuid(7), credentialRevision: 1,
      connectionRevision: 1, adoptionId: uuid(8), materialVersion: 1, displayName: "Account" } };
}
function peer() {
  const handlers = new Map<string, (message: unknown) => void>();
  const current = { value: binding as CloudAgentBootConversation | null };
  const off = vi.fn(), read = vi.fn((folder: string) => folder === cloudWorkspaceKey(binding) ? current.value : null);
  const bridge = { cloudAgentBootBinding: read, on: (type: string, listener: (message: unknown) => void) => {
    handlers.set(type, listener); return () => { handlers.delete(type); off(); };
  } };
  return { bridge, current, off, handlers, read };
}
beforeEach(() => useSessionsStore.getState().clearAll());
describe("native-use receiver owner fences", () => {
  it("updates hidden chat state from the authenticated cached binding without reads/wakes", () => {
    const p = peer(), stop = wireCloudAgentCredentialState(p.bridge, useSessionsStore.getState);
    p.handlers.get("CLOUD_AGENT_CREDENTIAL_USED")!({ use: use() });
    const entry = useSessionsStore.getState().cloudAgentCredentials[cloudScopedId(binding, "chat")];
    expect(entry?.state.notice?.nativeStage).toBe("sdk_run_created"); expect(p.read).toHaveBeenCalledExactlyOnceWith(cloudWorkspaceKey(binding));
    stop(); expect(p.handlers.size).toBe(0); expect(p.off).toHaveBeenCalledTimes(3);
  });
  it("ignores delayed callbacks after account/peer retirement and exact new-boot replacement", () => {
    const p = peer(), stop = wireCloudAgentCredentialState(p.bridge, useSessionsStore.getState);
    p.current.value = null; p.handlers.get("CLOUD_AGENT_CREDENTIAL_USED")!({ use: use() });
    p.current.value = { ...binding, writerEpoch: uuid(80) }; p.handlers.get("CLOUD_AGENT_CREDENTIAL_USED")!({ use: use() });
    expect(useSessionsStore.getState().cloudAgentCredentials).toEqual({}); stop();
  });
  it("does not treat selected/audit data or malformed native source as actual use", () => {
    const p = peer(), stop = wireCloudAgentCredentialState(p.bridge, useSessionsStore.getState);
    const send = p.handlers.get("CLOUD_AGENT_CREDENTIAL_USED")!;
    send({ credentialRun: use().credentialRun }); send({ use: { ...use(), nativeStage: "dispatch" } });
    send({ use: { ...use(), scope: { ...use().scope, authorityEpoch: 99 } } });
    expect(useSessionsStore.getState().cloudAgentCredentials).toEqual({}); stop();
  });
  it("installs retained original-use snapshots only under their scoped conversation and current binding", () => {
    const p = peer(), stop = wireCloudAgentCredentialState(p.bridge, useSessionsStore.getState);
    const send = p.handlers.get("AGENT_SESSION_LOADED")!;
    send({ cloudSnapshot: { conversationId: "chat", cloudCredentialUses: [use()] } });
    expect(useSessionsStore.getState().cloudAgentCredentials).toEqual({});
    send({ cloudSnapshot: { conversationId: cloudScopedId(binding, "chat"), cloudCredentialUses: [use()] } });
    expect(useSessionsStore.getState().cloudAgentCredentials[cloudScopedId(binding, "chat")]?.state.notice).toBeDefined(); stop();
  });
  it("adds no subscriptions to legacy or Local-only clients without a cached cloud selector", () => {
    const on = vi.fn(); wireCloudAgentCredentialState({ on }, useSessionsStore.getState)(); expect(on).not.toHaveBeenCalled();
  });
});
