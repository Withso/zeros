import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import * as Wire from "../../../../packages/protocol/src/cloud-agent-bootstrap.js";
import * as Standalone from "./agent-boot-contract.js";
import { createCloudAgentExecutionRoutes } from "./agent-credential-routes.js";
import type { DatabaseCloudAgentExecutionService } from "./agent-executions.js";
import { HttpError } from "../authz.js";

const scope = () => ({ organizationId: randomUUID(), workspaceId: randomUUID(), generation: 2,
  engineInstanceId: randomUUID(), bootId: randomUUID(), writerEpoch: randomUUID(), fundingOwnerUserId: randomUUID(), fundingOwnerEpoch: 1 });
function fixture() {
  const target = scope(), { writerEpoch: _writer, ...identity } = target;
  const request = { version: 1, mode: "boot-owner-v1", organizationId: target.organizationId, workspaceId: target.workspaceId,
    generation: target.generation, engineInstanceId: target.engineInstanceId };
  const predecessor = { ...target, engineInstanceId: randomUUID(), writerEpoch: randomUUID(), bootId: randomUUID() };
  const response = { ...identity, version: 1, mode: "boot-owner-v1", recoveryId: randomUUID(), code: "history_recovered_with_gap", coverage: "unknown",
    predecessor, predecessorRetiredAt: "2026-10-14T12:00:00.123456Z", checkpoint: { writerEpoch: randomUUID(), sha256: "a".repeat(64) },
    mirroredSequence: 9, preparedCustody: [{ scope: { ...predecessor, engineInstanceId: randomUUID(), writerEpoch: randomUUID(), bootId: randomUUID() },
      recoveryId: randomUUID(), retiredAt: "2026-10-14T12:01:00.123456Z" }] };
  return { request, response };
}
type Parser = { safeParse(value: unknown): { success: boolean; data?: unknown } };
function parity(left: Parser, right: Parser, input: unknown, valid: boolean) {
  const a = left.safeParse(input), b = right.safeParse(input);
  expect(a.success).toBe(valid); expect(b.success).toBe(valid);
  if (valid) expect(a.data).toEqual(b.data);
}

describe("private history recovery contracts", () => {
  it("keeps standalone and runtime recovery schemas identical and bounds custody hints without source selectors", () => {
    const { request, response } = fixture();
    parity(Standalone.CloudAgentHistoryRecoveryRequestSchema, Wire.CloudAgentHistoryRecoveryRequestSchema, request, true);
    const hints = response.preparedCustody.map(item => ({ writerEpoch: item.scope.writerEpoch, recoveryId: item.recoveryId }));
    parity(Standalone.CloudAgentHistoryRecoveryRequestSchema, Wire.CloudAgentHistoryRecoveryRequestSchema, { ...request, preparedCustody: hints }, true);
    for (const patch of [{ writerEpoch: randomUUID() }, { predecessor: response.predecessor }, { coverage: "empty" },
      { preparedCustody: [...hints, ...hints] }, { preparedCustody: Array.from({ length: 3 }, () => ({ writerEpoch: randomUUID(), recoveryId: randomUUID() })) }])
      parity(Standalone.CloudAgentHistoryRecoveryRequestSchema, Wire.CloudAgentHistoryRecoveryRequestSchema, { ...request, ...patch }, false);
    parity(Standalone.CloudAgentHistoryRecoveryResponseSchema, Wire.CloudAgentHistoryRecoveryResponseSchema, response, true);
    const { preparedCustody: _custody, ...withoutPrepared } = response;
    parity(Standalone.CloudAgentHistoryRecoveryResponseSchema, Wire.CloudAgentHistoryRecoveryResponseSchema, withoutPrepared, true);
    for (const patch of [{ coverage: "empty" }, { code: "private-error" }, { mirroredSequence: -1 }, { material: "private-value" },
      { preparedCustody: [...response.preparedCustody, ...response.preparedCustody] }])
      parity(Standalone.CloudAgentHistoryRecoveryResponseSchema, Wire.CloudAgentHistoryRecoveryResponseSchema, { ...response, ...patch }, false);
    parity(Standalone.CloudAgentHistoryRecoveryResponseSchema, Wire.CloudAgentHistoryRecoveryResponseSchema,
      { ...response, predecessorRecovery: { recoveryId: randomUUID(), custodySha256: "a".repeat(64) } }, true);
    parity(Standalone.CloudAgentHistoryRecoveryResponseSchema, Wire.CloudAgentHistoryRecoveryResponseSchema,
      { ...response, predecessorRecovery: { recoveryId: randomUUID(), custodySha256: "bad" } }, false);
    const activation = { ...request, bootId: randomUUID(), writerEpoch: randomUUID(), expectedCacheRevision: 1,
      historyRecoveryId: response.recoveryId, historyRecoveryCustodySha256: "a".repeat(64) };
    parity(Standalone.CloudAgentBootActivateRequestSchema, Wire.CloudAgentBootActivateRequestSchema, activation, true);
    parity(Standalone.CloudAgentBootActivateRequestSchema, Wire.CloudAgentBootActivateRequestSchema, { ...activation, historyRecoveryId: "invalid" }, false);
    parity(Standalone.CloudAgentBootActivateRequestSchema, Wire.CloudAgentBootActivateRequestSchema, { ...activation, historyRecoveryCustodySha256: undefined }, false);
    parity(Standalone.CloudAgentBootActivateRequestSchema, Wire.CloudAgentBootActivateRequestSchema, { ...activation, historyRecoveryId: undefined }, false);
  });

  it("requires the engine heartbeat, admits only the exact closed response and never exposes an unknown failure", async () => {
    const { request, response } = fixture(), boot = vi.fn().mockResolvedValue(response);
    const app = createCloudAgentExecutionRoutes({ boot } as unknown as DatabaseCloudAgentExecutionService);
    const token = `zwh_${"x".repeat(43)}`;
    const call = (value: unknown = request, authorization = `Bearer ${token}`) => app.request("/internal/v2/cloud-workspaces/engine/agent-boot/recover-history", {
      method: "POST", headers: { "content-type": "application/json", authorization }, body: JSON.stringify(value),
    });
    expect((await call(request, "Bearer browser-session")).status).toBe(401);
    expect((await call({ ...request, writerEpoch: randomUUID() })).status).toBe(422);
    expect(boot).not.toHaveBeenCalled();
    const accepted = await call();
    expect(accepted.status).toBe(200); expect(accepted.headers.get("cache-control")).toBe("no-store");
    expect(await accepted.json()).toEqual({ result: response });
    expect(boot).toHaveBeenCalledWith({ organizationId: request.organizationId, workspaceId: request.workspaceId,
      generation: request.generation, engineInstanceId: request.engineInstanceId, heartbeatToken: token }, "recover-history", request);
    for (const bad of [{ ...response, engineInstanceId: randomUUID() }, { ...response, coverage: "empty" }]) {
      boot.mockResolvedValueOnce(bad); const result = await call();
      expect(result.status).toBe(503); expect(await result.json()).toEqual({ error: "cloud_validation_authority_unavailable" });
    }
    boot.mockRejectedValueOnce(new HttpError(403, "cloud_validation_access_denied", "private SQL and provider output"));
    const refused = await call(); expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "cloud_validation_access_denied" });
  });
});
