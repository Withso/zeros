import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CloudLocalCommandMirrorBatchSchema as SharedBatch, CloudLocalCommandMirrorAckSchema as SharedAck } from "../../../../packages/protocol/src/cloud-local-mirror.js";
import { CloudLocalCommandMirrorBatchSchema, CloudLocalCommandMirrorAckSchema, CloudCommandError,
  type DatabaseCloudWorkspaceCommandService } from "./commands.js";
import { CLOUD_COMMAND_MIRROR_PATH, createCloudCommandRoutes } from "./command-routes.js";

const scope = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 1, engineInstanceId: randomUUID() };
const bootId = randomUUID(), writerEpoch = randomUUID(), batchId = randomUUID();
const batch = { version: 1 as const, bootId, writerEpoch, batchId, after: 0, through: 1,
  changes: [{ sequence: 1, conversationId: "chat", revision: 0, paused: false }] };
const ack = { version: 1 as const, writerEpoch, batchId, through: 1 };
describe("standalone CP mirror schema parity", () => {
  it.each([
    batch, { ...batch, extra: "private" }, { ...batch, after: 1 }, { ...batch, through: 2 },
    { ...batch, changes: [] }, { ...batch, changes: [{ ...batch.changes[0], sequence: 2 }] },
    { ...batch, changes: [{ ...batch.changes[0], history: { recordSequence: 1, eventSequence: 1 } }] },
    { ...batch, changes: [{ ...batch.changes[0], historyHead: { originWriterEpoch: writerEpoch, deleted: true,
      source: { kind: "mutation", mutationId: randomUUID(), operation: "delete" },
      history: { restoreRevision: 1, recordSequence: null, eventSequence: null, incompleteReason: "capture_unavailable" } } }] },
    { ...batch, changes: [{ ...batch.changes[0], entry: { commandId: randomUUID(), position: 1, state: "failed", payload: null,
      executionId: "execution", generation: 1, resultCode: "fixture_failure", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      originWriterEpoch: writerEpoch, intent: { userMessageId: "turn", agentId: "claude" },
      history: { restoreRevision: 1, recordSequence: 1, eventSequence: 2, incompleteReason: "capture_unavailable" } }] },
  ])("matches the shared batch parser %#", value => {
    expect(CloudLocalCommandMirrorBatchSchema.safeParse(value).success).toBe(SharedBatch.safeParse(value).success);
  });
  it.each([ack, { ...ack, extra: "private" }, { ...ack, through: -1 },
    { ...ack, historyLimits: [{ conversationId: "chat", sha256: "a".repeat(64) }] },
    { ...ack, historyLimits: [{ conversationId: "chat", sha256: "bad" }] },
    { ...ack, historyLimits: Array(2).fill({ conversationId: "chat", sha256: "a".repeat(64) }) },
  ])("matches exact bounded shared ACK parser %#", value => {
    expect(CloudLocalCommandMirrorAckSchema.safeParse(value).success).toBe(SharedAck.safeParse(value).success);
  });
});
describe("authenticated CP local mirror route", () => {
  const token = `zwh_${"a".repeat(43)}`;
  function service() {
    const mirror = vi.fn(async () => ack);
    const routes = createCloudCommandRoutes({ mirror } as unknown as DatabaseCloudWorkspaceCommandService);
    const post = (body: unknown, bearer = token, contentType = "application/json") => routes.request("/internal/v2/cloud-workspaces/engine/commands/mirror", {
      method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": contentType }, body: JSON.stringify(body) });
    return { mirror, post };
  }
  it("uses the frozen strict envelope and invokes actual service with engine authority", async () => {
    const f = service(), response = await f.post({ ...scope, batch });
    expect(CLOUD_COMMAND_MIRROR_PATH).toBe("/internal/v2/cloud-workspaces/engine/commands/mirror");
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ result: ack });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(f.mirror).toHaveBeenCalledWith({ ...scope, heartbeatToken: token }, batch);
  });
  it.each(["zwa", "zws", "api-key", ""])("rejects %s carrier before service", async prefix => {
    const f = service(), response = await f.post({ ...scope, batch }, `${prefix}_${"a".repeat(43)}`);
    expect(response.status).toBe(401); expect(await response.json()).toEqual({ error: "engine_authority_rejected" });
    expect(f.mirror).not.toHaveBeenCalled();
  });
  it.each(["extra", "actor", "nested", "sequence", "content-type", "oversized"])("rejects invalid %s without projection", async kind => {
    const f = service(); const body = kind === "extra" ? { ...scope, batch, endpoint: "https://foreign.invalid" }
      : kind === "actor" ? { ...scope, batch, actorSessionId: randomUUID() } : kind === "nested" ? { ...scope, request: { batch } }
        : kind === "sequence" ? { ...scope, batch: { ...batch, through: 3 } }
          : kind === "oversized" ? { ...scope, batch, private: "x".repeat(1024 * 1024) } : { ...scope, batch };
    const response = await f.post(body, token, kind === "content-type" ? "text/plain" : "application/json");
    expect(response.status).toBe(kind === "oversized" ? 413 : 422); expect(f.mirror).not.toHaveBeenCalled();
  });
  it("retains typed conflicts and never emits SQL/provider error prose", async () => {
    const f = service(); f.mirror.mockRejectedValueOnce(new CloudCommandError("command_context_changed", "private-prose"));
    const denied = await f.post({ ...scope, batch }); expect(denied.status).toBe(409); expect(await denied.json()).toEqual({ error: "command_context_changed" });
    f.mirror.mockRejectedValueOnce(new Error("private-query-prose"));
    const failed = await f.post({ ...scope, batch }); expect(failed.status).toBe(503); expect(await failed.json()).toEqual({ error: "command_service_unavailable" });
  });
});
