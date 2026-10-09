import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudAgentBootConversationSchema } from "@zeros/protocol/cloud-agent-bootstrap";
import { ZerosEngine } from "../zeros-engine";
import { closeZerosDb, setZerosDbPathForTesting } from "../db";
import { upsertChat } from "../db/chats";
import type { TransportClient } from "../transport/types";

const methods = ZerosEngine.prototype as unknown as {
  handleConnect(this: unknown, client: TransportClient): Promise<void>;
  handleCloudCommandOperation(this: unknown, op: string, params: Record<string, unknown>, client: TransportClient): Promise<unknown>;
  validateCloudCommand(this: unknown, conversationId: string): void;
  handleCloudEventOperation(this: unknown, params: Record<string,unknown>,client: TransportClient): Promise<unknown>;
};
const directories: string[] = [];
afterEach(() => { closeZerosDb(); setZerosDbPathForTesting(null); for (const folder of directories.splice(0)) rmSync(folder, { recursive: true, force: true }); });
function fixture() {
  const folder = mkdtempSync(path.join(tmpdir(), "zeros-local-command-engine-")); directories.push(folder);
  const root = path.join(folder, "workspace"); mkdirSync(root); setZerosDbPathForTesting(path.join(folder, "state.db"));
  const metadata = CloudAgentBootConversationSchema.parse({ version: 1, mode: "boot-owner-v1", fundingScope: "workspace-roles-v1",
    organizationId: randomUUID(), workspaceId: randomUUID(), generation: 1, engineInstanceId: randomUUID(), bootId: randomUUID(),
    writerEpoch: randomUUID(), fundingOwnerUserId: randomUUID(), fundingOwnerEpoch: 1, authorityEpoch: 1,
    cacheRevision: 1, desiredCacheRevision: 1, initialAdoptions: ["claude", "codex", "cursor"].map(provider => ({ provider, status: "unknown" })) });
  const sessionId = randomUUID(), client: TransportClient = { id: randomUUID(), kind: "cloud", accountUserId: metadata.fundingOwnerUserId,
    authorityEpoch: 1, cloudActor: { sessionId, deviceId: randomUUID(), role: "owner", fingerprint: "a".repeat(64) },
    authorized: () => true, send: vi.fn(), close: vi.fn() };
  const boot = { active: true, metadataFor: vi.fn((session: string) => { if (session !== sessionId) throw new Error("foreign actor"); return metadata; }),
    observeConversation: vi.fn(async () => {}) };
  const engine = { root, cloudWorker: { version: 4 }, cloudAgentBoot: boot, cloudCommands: { handle: vi.fn(async () => ({ conversationId: "chat", revision: 0, paused: false, pending: [], receipts: [] })) },
    cloudRuntimeAuthorityStopping: false, actualPort: 1234, framework: "unknown", validateCloudCommand: methods.validateCloudCommand,
    workspace: { workspaceIdForCwd: () => "local-main" }, broadcast: vi.fn() };
  upsertChat({ id: "chat", folder: root, agentId: "claude", agentName: "Claude", model: "test-model", effort: "",
    permissionMode: "default", lastModeId: null, prePlanModeId: null, fast: false, additionalDirectories: [],
    title: "", createdAt: 1, updatedAt: 1, sessionId: null, pinned: false, archived: false, sourceChatId: null, kind: null });
  return { metadata, client, engine, boot };
}
describe("negotiated local cloud engine boundary", () => {
  it("fences local replay when the independently confirmed actor expires", async () => {
    const f = fixture(),replay = vi.fn(async () => ({ replayed: true }));
    const engine = { ...f.engine,cloudEvents: { replay } };
    f.boot.metadataFor.mockImplementation(() => { throw Object.assign(new Error("Expired cached actor"),{ code: "cloud_actor_authority_rejected" }); });
    await expect(methods.handleCloudEventOperation.call(engine,{ request: { kind: "replay",cursor: { streamId: f.metadata.engineInstanceId,sequence: 0 } } },f.client))
      .rejects.toMatchObject({ code: "cloud_actor_authority_rejected" });
    expect(replay).not.toHaveBeenCalled();
  });
  it("publishes boot capability and exact metadata only for the confirmed cloud actor", async () => {
    const f = fixture(); await methods.handleConnect.call(f.engine, f.client);
    expect(f.client.send).toHaveBeenLastCalledWith(expect.objectContaining({ type: "ENGINE_READY", cloudLocalCommands: f.metadata,
      capabilities: expect.arrayContaining(["cloud.localCommands.v1"]) }));
    for (const client of [{ ...f.client, kind: "local" as const }, { ...f.client, authorized: () => false },
      { ...f.client, cloudActor: { ...f.client.cloudActor!, sessionId: randomUUID() } }]) {
      await methods.handleConnect.call(f.engine, client);
      expect(vi.mocked(f.client.send).mock.calls.at(-1)![0]).not.toHaveProperty("cloudLocalCommands");
    }
  });
  it("returns cached boot metadata and schedules conversation warming without awaiting CP on Send", async () => {
    const f = fixture(); f.boot.observeConversation.mockImplementation(() => new Promise(() => {}));
    await expect(methods.handleCloudCommandOperation.call(f.engine, "cloudCommands.conversation", { conversationId: "chat" }, f.client))
      .resolves.toMatchObject({ cloudLocalCommands: f.metadata });
    expect(f.boot.observeConversation).toHaveBeenCalledWith(f.client.cloudActor!.sessionId, "chat");
  });
  it("requires the exact activated writer opt-in before any local queue operation", async () => {
    const f = fixture(), request = { kind: "snapshot", conversationId: "chat" };
    const params = { request, nativeCommandsVersion: 1, cloudTurnProtocolVersion: 1,
      cloudLocalCommandsVersion: 1, bootId: f.metadata.bootId, writerEpoch: f.metadata.writerEpoch };
    await expect(methods.handleCloudCommandOperation.call(f.engine, "cloudCommands.request", params, f.client)).resolves.toMatchObject({ conversationId: "chat" });
    expect(f.engine.cloudCommands.handle).toHaveBeenCalledTimes(1);
    for (const changed of [{ cloudLocalCommandsVersion: undefined }, { bootId: randomUUID() }, { writerEpoch: randomUUID() }]) {
      await expect(methods.handleCloudCommandOperation.call(f.engine, "cloudCommands.request", { ...params, ...changed }, f.client))
        .rejects.toMatchObject({ code: "cloud_workspace_client_update_required" });
    }
    expect(f.engine.cloudCommands.handle).toHaveBeenCalledTimes(1);
  });
});
