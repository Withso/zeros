import { beforeEach, describe, expect, it } from "vitest";
import { BLANK, useSessionsStore } from "../sessions-store";
import { cloudScopedId, cloudWorkspaceKey } from "../../../platform/bridge/cloud-workspace-key";
import type { CloudHistoryRestoreFence } from "../../../platform/cloud-transcript-cache-contract";

const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const chat = cloudScopedId(target, "chat"), sibling = cloudScopedId(target, "sibling");
const projection: CloudHistoryRestoreFence["projection"] = { ...target, generation: 2,
  engineInstanceId: "33333333-3333-4333-8333-333333333333", bootId: "44444444-4444-4444-8444-444444444444",
  writerEpoch: "55555555-5555-4555-8555-555555555555", fundingOwnerUserId: "66666666-6666-4666-8666-666666666666",
  fundingOwnerEpoch: 1, version: 1, mode: "boot-owner-v1", fundingScope: "workspace-roles-v1", mirroredSequence: 10, sealedSequence: null, complete: false };
const head: CloudHistoryRestoreFence = { projection, conversationId: "chat", head: { conversationId: "chat", originWriterEpoch: projection.writerEpoch,
  source: { kind: "mutation", mutationId: "77777777-7777-4777-8777-777777777777", operation: "edit" }, restoreRevision: 2,
  deleted: false, recordSequence: null, eventSequence: 5, manifestSha256: null, incompleteReason: "history_limit" } };
const reply = { id: "old-reply", kind: "text" as const, role: "agent" as const, text: "old transcript", createdAt: 1 };
const bubble = { id: "queued", kind: "text" as const, role: "user" as const, text: "next turn", queued: true, createdAt: 2 };
beforeEach(() => {
  useSessionsStore.getState().clearAll();
  for (const id of [chat, sibling]) useSessionsStore.getState().setSession(id, { ...BLANK, cwd: cloudWorkspaceKey(target),
    agentId: "codex", transcriptState: "resident", messages: [reply, bubble], hasTranscript: true });
});
describe("normalized cloud transcript restore fences", () => {
  it("fences visible history without completing the unknown transcript or losing queued intent and siblings", () => {
    const other = useSessionsStore.getState().sessions[sibling];
    useSessionsStore.getState().applyCloudHistoryRestoreHead(chat, head);
    expect(useSessionsStore.getState().sessions[chat]).toMatchObject({ messages: [bubble], transcriptState: "loading", hasTranscript: true });
    expect(useSessionsStore.getState().sessions[sibling]).toBe(other);
    expect(useSessionsStore.getState().cloudHistoryRestoreHeads[chat]).toEqual(head);
  });
  it("preserves the exact newer native transcript instead of comparing CP and VM revisions", () => {
    useSessionsStore.getState().patchSession(chat, { status: "streaming", executionId: cloudScopedId(target, "native"),
      activeTurnStartedAt: 30, lastStopReason: null });
    const live = useSessionsStore.getState().sessions[chat];
    useSessionsStore.getState().applyCloudHistoryRestoreHead(chat, { ...head, head: { ...head.head!, restoreRevision: 1000 } }, true);
    expect(useSessionsStore.getState().sessions[chat]).toBe(live);
    expect(useSessionsStore.getState().cloudHistoryRestoreHeads[chat]?.head?.restoreRevision).toBe(1000);
  });
  it("retains a newer optimistic user bubble while blocking an incomplete old transcript", () => {
    useSessionsStore.getState().setPendingLocalTurn(chat, reply.id);
    useSessionsStore.getState().applyCloudHistoryRestoreHead(chat, head);
    expect(useSessionsStore.getState().sessions[chat]?.messages).toEqual([reply, bubble]);
    expect(useSessionsStore.getState().pendingLocalTurns[chat]).toBe(reply.id);
  });
  it("installs a deletion as known absence and later verified repair as a fresh loading transcript", () => {
    const deleted = { ...head, head: { ...head.head!, deleted: true, source: { ...head.head!.source, operation: "delete" as const } } };
    useSessionsStore.getState().applyCloudHistoryRestoreHead(chat, deleted);
    expect(useSessionsStore.getState().sessions[chat]).toMatchObject({ messages: [bubble], transcriptState: "resident", hasTranscript: false });
    const repair: CloudHistoryRestoreFence = { ...head, projection: { ...projection, mirroredSequence: 20 }, head: { ...head.head!,
      restoreRevision: 3, source: { kind: "mutation", mutationId: "88888888-8888-4888-8888-888888888888", operation: "repair" },
      recordSequence: 1, manifestSha256: "a".repeat(64), incompleteReason: null } };
    useSessionsStore.getState().applyCloudHistoryRestoreHead(chat, repair);
    expect(useSessionsStore.getState().sessions[chat]).toMatchObject({ messages: [bubble], transcriptState: "loading" });
    useSessionsStore.getState().applyCloudHistoryRestoreHead(chat, head);
    expect(useSessionsStore.getState().cloudHistoryRestoreHeads[chat]).toEqual(repair);
  });
  it.each(["/personal/local", "/organization/local"])("does not change %s or a foreign cloud conversation", cwd => {
    useSessionsStore.getState().setSession("local", { ...BLANK, cwd, messages: [reply], transcriptState: "resident" });
    const before = useSessionsStore.getState();
    useSessionsStore.getState().applyCloudHistoryRestoreHead("local", head);
    useSessionsStore.getState().applyCloudHistoryRestoreHead(sibling, head);
    expect(useSessionsStore.getState()).toBe(before);
  });
});
