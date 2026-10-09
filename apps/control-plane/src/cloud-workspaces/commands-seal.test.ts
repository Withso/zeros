import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { canonicalCloudHistoryJson } from "./history-local-contract.js";
import { CloudCommandError, CloudLocalCommandWriterSealSchema, CloudLocalCommandWriterSealAckSchema, type DatabaseCloudWorkspaceCommandService } from "./commands.js";
import { CloudLocalCommandWriterSealSchema as SharedSeal, CloudLocalCommandWriterSealAckSchema as SharedAck,
  canonicalCloudLocalCommandWriterSealDescriptor } from "../../../../packages/protocol/src/cloud-local-mirror.js";
import { createCloudCommandRoutes } from "./command-routes.js";
import { CloudWorkspaceEngineAuthorityError } from "./engine-authority.js";

const path = "/internal/v2/cloud-workspaces/engine/commands/seal";
function setup() {
  const binding = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 1, engineInstanceId: randomUUID() };
  const fields = { version: 1 as const, scope: { ...binding, bootId: randomUUID(), writerEpoch: randomUUID(),
    fundingOwnerUserId: randomUUID(), fundingOwnerEpoch: 1 }, sealId: randomUUID(), sequence: 0, recordSequence: 0, eventSequence: 0, inventorySha256: "a".repeat(64) };
  const seal = { ...fields, sha256: createHash("sha256").update(canonicalCloudHistoryJson(fields)).digest("hex") };
  const ack = { version: 1, sealId: seal.sealId, writerEpoch: seal.scope.writerEpoch,
    sequence: 0, recordSequence: 0, eventSequence: 0, inventorySha256: seal.inventorySha256, sha256: seal.sha256 };
  const token = `zwh_${"a".repeat(43)}`, service = { seal: vi.fn(async () => ack) };
  const routes = createCloudCommandRoutes(service as unknown as DatabaseCloudWorkspaceCommandService);
  const post = (body: unknown = { ...binding, seal }, bearer = token, contentType = "application/json") => routes.request(path, {
    method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": contentType }, body: JSON.stringify(body) });
  return { binding, seal, ack, token, service, post };
}
describe("standalone seal schema and canonical descriptor parity", () => {
  it("retains the exact shared required inventory and eight-field descriptor bytes", () => {
    const f = setup(), parsed = CloudLocalCommandWriterSealSchema.parse(f.seal), { sha256: _hash, ...fields } = parsed;
    expect(canonicalCloudHistoryJson(fields)).toBe(canonicalCloudLocalCommandWriterSealDescriptor(f.seal));
    expect(CloudLocalCommandWriterSealAckSchema.parse(f.ack)).toEqual(SharedAck.parse(f.ack));
  });
  it.each(["valid", "extra", "scope-extra", "inventory", "digest", "negative", "unsafe", "null"])("matches shared seal rejection %s", kind => {
    const f = setup(), { inventorySha256: _inventory, ...withoutInventory } = f.seal;
    const value = kind === "valid" ? f.seal : kind === "extra" ? { ...f.seal, sourceRetired: true }
      : kind === "scope-extra" ? { ...f.seal, scope: { ...f.seal.scope, mode: "boot-owner-v1" } }
        : kind === "inventory" ? withoutInventory : kind === "digest" ? { ...f.seal, sha256: "invalid" }
          : kind === "negative" ? { ...f.seal, eventSequence: -1 } : kind === "unsafe" ? { ...f.seal, recordSequence: Number.MAX_SAFE_INTEGER + 1 } : null;
    expect(CloudLocalCommandWriterSealSchema.safeParse(value).success).toBe(SharedSeal.safeParse(value).success);
    expect(CloudLocalCommandWriterSealSchema.safeParse(value).success).toBe(kind === "valid");
  });
  it.each(["valid", "extra", "inventory", "unsafe", "null"])("matches strict shared ACK %s", kind => {
    const f = setup(), { inventorySha256: _inventory, ...withoutInventory } = f.ack;
    const value = kind === "valid" ? f.ack : kind === "extra" ? { ...f.ack, sourceRetired: true } : kind === "inventory" ? withoutInventory
      : kind === "unsafe" ? { ...f.ack, sequence: Number.MAX_SAFE_INTEGER + 1 } : null;
    expect(CloudLocalCommandWriterSealAckSchema.safeParse(value).success).toBe(SharedAck.safeParse(value).success);
    expect(CloudLocalCommandWriterSealAckSchema.safeParse(value).success).toBe(kind === "valid");
  });
});
describe("exact current-writer private seal route", () => {
  it("binds the immutable seal to engine heartbeat authority and returns only its exact ACK", async () => {
    const f = setup(), response = await f.post();
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ result: f.ack });
    expect(f.service.seal).toHaveBeenCalledWith({ ...f.binding, heartbeatToken: f.token }, f.seal);
  });
  it.each(["zwa", "zws", "key", ""])("rejects %s authority before invoking seal", async prefix => {
    const f = setup(), response = await f.post(undefined, `${prefix}_${"a".repeat(43)}`);
    expect(response.status).toBe(401); expect(f.service.seal).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({ error: "engine_authority_rejected" });
  });
  it.each(["extra", "actor", "nested-extra", "scope-extra", "negative", "unsafe", "digest", "content-type", "oversized"])("rejects invalid %s before storage", async kind => {
    const f = setup();
    const body = kind === "extra" ? { ...f.binding, seal: f.seal, endpoint: "https://foreign.invalid" }
      : kind === "actor" ? { ...f.binding, seal: f.seal, actorSessionId: randomUUID() }
        : kind === "nested-extra" ? { ...f.binding, seal: { ...f.seal, sourceRetired: true } }
          : kind === "scope-extra" ? { ...f.binding, seal: { ...f.seal, scope: { ...f.seal.scope, retired: true } } }
            : kind === "negative" ? { ...f.binding, seal: { ...f.seal, sequence: -1 } }
              : kind === "unsafe" ? { ...f.binding, seal: { ...f.seal, recordSequence: Number.MAX_SAFE_INTEGER + 1 } }
                : kind === "digest" ? { ...f.binding, seal: { ...f.seal, sha256: "invalid" } }
                  : kind === "oversized" ? { ...f.binding, seal: f.seal, private: "x".repeat(16 * 1024) }
                    : { ...f.binding, seal: f.seal };
    const response = await f.post(body, undefined, kind === "content-type" ? "text/plain" : "application/json");
    expect(response.status).toBe(kind === "oversized" ? 413 : 422); expect(f.service.seal).not.toHaveBeenCalled();
  });
  it.each([
    [new CloudCommandError("command_context_changed", "fixture-private-detail"), 409, "command_context_changed"],
    [new CloudCommandError("command_conflict", "fixture-private-detail"), 409, "command_conflict"],
    [new CloudWorkspaceEngineAuthorityError(), 401, "engine_authority_rejected"],
    [new Error("fixture-private-detail"), 503, "command_service_unavailable"],
  ] as const)("retains only closed errors %#", async (error, status, code) => {
    const f = setup(); f.service.seal.mockRejectedValueOnce(error);
    const response = await f.post(); expect(response.status).toBe(status); expect(await response.json()).toEqual({ error: code });
  });
});
