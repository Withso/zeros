import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as controls from "./agent-credential-mutations.js";

const scope = {
  organizationId: randomUUID(), workspaceId: randomUUID(), generation: 1,
  engineInstanceId: randomUUID(), bootId: randomUUID(), writerEpoch: randomUUID(),
  fundingOwnerUserId: randomUUID(), fundingOwnerEpoch: 1,
};
const credentialId = randomUUID();
const request = {
  ...scope, version: 1, mutationId: randomUUID(), controlRequestId: randomUUID(), fenceEpoch: 1,
  selectors: [{ provider: "codex", credentialId }], operation: "pause-starts", desiredCacheRevision: null,
};
const run = {
  version: 1, bootId: scope.bootId, writerEpoch: scope.writerEpoch, cacheRevision: 1,
  provider: "codex", fundingOwnerUserId: scope.fundingOwnerUserId, fundingOwnerEpoch: 1,
  credentialId, credentialRevision: 1, connectionRevision: 1, adoptionId: randomUUID(),
  materialVersion: 1, displayName: "Test connection",
};
const item = {
  executionId: randomUUID(), conversationId: randomUUID(), commandId: randomUUID(),
  phase: "foreground", credentialRun: run,
};
const acknowledgement = {
  ...scope, version: 1, mutationId: request.mutationId, controlRequestId: request.controlRequestId,
  fenceEpoch: 1, controlRevision: 1, phase: "fenced", mutationFenced: true, startsFenced: true,
  desiredCacheRevision: null, readyCacheRevision: 1, proofId: null,
  activity: { complete: true, foreground: 1, reservedLaunches: 0, background: 0, idleHosts: 0, scopes: [item] },
};
const exchange = {
  version: 1, mode: "boot-owner-v1", organizationId: scope.organizationId, workspaceId: scope.workspaceId,
  generation: 1, engineInstanceId: scope.engineInstanceId, bootId: scope.bootId, writerEpoch: scope.writerEpoch,
  acknowledgements: [acknowledgement],
};

describe("private credential controls", () => {
  it.each(["pause-starts", "publish-desired", "retire", "release"])("accepts the closed %s control", operation => {
    const value = { ...request, operation, desiredCacheRevision: operation === "publish-desired" ? 2 : null };
    expect(controls.CloudAgentCredentialControlRequestSchema.parse(value)).toEqual(value);
  });
  it.each(["material", "accessToken", "refreshToken", "environment", "argv", "path", "actorUserId"])(
    "excludes private/native %s from every envelope", key => {
      expect(controls.CloudAgentCredentialControlRequestSchema.safeParse({ ...request, [key]: "synthetic" }).success).toBe(false);
      expect(controls.CloudAgentCredentialControlAcknowledgementSchema.safeParse({ ...acknowledgement, [key]: "synthetic" }).success).toBe(false);
      expect(controls.CloudAgentCredentialControlExchangeRequestSchema.safeParse({ ...exchange, [key]: "synthetic" }).success).toBe(false);
    },
  );
  it.each([[], Array(33).fill(request.selectors[0]), [request.selectors[0], request.selectors[0]]])(
    "refuses empty, oversized or repeated selectors", selectors => {
      expect(controls.CloudAgentCredentialControlRequestSchema.safeParse({ ...request, selectors }).success).toBe(false);
    },
  );
  it("covers all old revisions with provider/credential identity, never a newest-only selector", () => {
    expect(controls.CloudAgentCredentialControlRequestSchema.parse(request).selectors).toEqual(request.selectors);
    for (const key of ["credentialRevision", "materialVersion", "cacheRevision", "connectionRevision"])
      expect(controls.CloudAgentCredentialControlRequestSchema.safeParse({ ...request,
        selectors: [{ ...request.selectors[0], [key]: 2 }] }).success).toBe(false);
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"])("refuses unbounded fence/control revision %s", value => {
    expect(controls.CloudAgentCredentialControlRequestSchema.safeParse({ ...request, fenceEpoch: value }).success).toBe(false);
    expect(controls.CloudAgentCredentialControlAcknowledgementSchema.safeParse({ ...acknowledgement, controlRevision: value }).success).toBe(false);
  });
  it("requires an explicit desired revision only for publication", () => {
    expect(controls.CloudAgentCredentialControlRequestSchema.safeParse({ ...request, operation: "publish-desired" }).success).toBe(false);
    expect(controls.CloudAgentCredentialControlRequestSchema.safeParse({ ...request, desiredCacheRevision: 2 }).success).toBe(false);
    expect(controls.CloudAgentCredentialControlRequestSchema.safeParse({ ...request, desiredCacheRevision: undefined }).success).toBe(false);
  });
  it("accepts real old active/reserved/background/idle captures", () => {
    const phases = ["foreground", "launch-reserved", "background", "idle"];
    const value = { ...acknowledgement, readyCacheRevision: 9, activity: {
      complete: true, foreground: 1, reservedLaunches: 1, background: 1, idleHosts: 1,
      scopes: phases.map(phase => ({ ...item, executionId: randomUUID(), phase })),
    } };
    expect(controls.CloudAgentCredentialControlAcknowledgementSchema.parse(value)).toEqual(value);
  });
  it.each(["bootId", "writerEpoch", "fundingOwnerUserId", "fundingOwnerEpoch"])(
    "refuses a foreign captured run %s", key => {
      const value = { ...acknowledgement, activity: { ...acknowledgement.activity,
        scopes: [{ ...item, credentialRun: { ...run, [key]: key === "fundingOwnerEpoch" ? 2 : randomUUID() } }] } };
      expect(controls.CloudAgentCredentialControlAcknowledgementSchema.safeParse(value).success).toBe(false);
    },
  );
  it("cannot turn incomplete inventory or idle hosts into retirement proof", () => {
    const empty = { complete: true, foreground: 0, reservedLaunches: 0, background: 0, idleHosts: 0, scopes: [] };
    const retired = { ...acknowledgement, phase: "retired", proofId: randomUUID(), activity: empty };
    expect(controls.CloudAgentCredentialControlAcknowledgementSchema.parse(retired)).toEqual(retired);
    for (const activity of [{ ...empty, complete: false }, { ...empty, idleHosts: 1 }, acknowledgement.activity])
      expect(controls.CloudAgentCredentialControlAcknowledgementSchema.safeParse({ ...retired, activity }).success).toBe(false);
    expect(controls.CloudAgentCredentialControlAcknowledgementSchema.safeParse({ ...retired, proofId: null }).success).toBe(false);
  });
  it("requires complete inventory counts to agree and bounds the inventory", () => {
    expect(controls.CloudAgentCredentialControlAcknowledgementSchema.safeParse({ ...acknowledgement,
      activity: { ...acknowledgement.activity, foreground: 0 } }).success).toBe(false);
    expect(controls.CloudAgentCredentialControlAcknowledgementSchema.safeParse({ ...acknowledgement,
      activity: { ...acknowledgement.activity, scopes: Array(257).fill(item) } }).success).toBe(false);
    expect(controls.CloudAgentCredentialControlAcknowledgementSchema.safeParse({ ...acknowledgement,
      activity: { ...acknowledgement.activity, complete: false } }).success).toBe(true);
  });
  it("never treats startsFenced alone as this mutation's acknowledged fence", () => {
    expect(controls.CloudAgentCredentialControlAcknowledgementSchema.safeParse({ ...acknowledgement, mutationFenced: false }).success).toBe(false);
    expect(controls.CloudAgentCredentialControlAcknowledgementSchema.safeParse({ ...acknowledgement, startsFenced: false }).success).toBe(false);
  });
  it("allows another overlapping fence after release or ready", () => {
    const released = { ...acknowledgement, phase: "released", mutationFenced: false, startsFenced: true };
    expect(controls.CloudAgentCredentialControlAcknowledgementSchema.parse(released)).toEqual(released);
    const ready = { ...released, phase: "ready", desiredCacheRevision: 2, readyCacheRevision: 2 };
    expect(controls.CloudAgentCredentialControlAcknowledgementSchema.parse(ready)).toEqual(ready);
    expect(controls.CloudAgentCredentialControlAcknowledgementSchema.safeParse({ ...ready, readyCacheRevision: 1 }).success).toBe(false);
  });
  it("keeps proof identity exclusive to actual retirement", () => {
    expect(controls.CloudAgentCredentialControlAcknowledgementSchema.safeParse({ ...acknowledgement, proofId: randomUUID() }).success).toBe(false);
  });
  it("bounds the authenticated background exchange and excludes funding selectors", () => {
    expect(controls.CloudAgentCredentialControlExchangeRequestSchema.parse(exchange)).toEqual(exchange);
    expect(controls.CloudAgentCredentialControlExchangeRequestSchema.parse({ ...exchange, acknowledgements: [] }).acknowledgements).toEqual([]);
    expect(controls.CloudAgentCredentialControlExchangeRequestSchema.safeParse({ ...exchange,
      acknowledgements: [acknowledgement, acknowledgement] }).success).toBe(false);
    expect(controls.CloudAgentCredentialControlExchangeRequestSchema.safeParse({ ...exchange,
      fundingOwnerUserId: scope.fundingOwnerUserId }).success).toBe(false);
    expect(controls.CloudAgentCredentialControlExchangeRequestSchema.safeParse({ ...exchange,
      acknowledgements: [{ ...acknowledgement, workspaceId: randomUUID() }] }).success).toBe(false);
  });
  it("bounds controls in the result without public removal fields", () => {
    const value = { version: 1, mode: "boot-owner-v1", controls: [request] };
    expect(controls.CloudAgentCredentialControlExchangeResponseSchema.parse(value)).toEqual(value);
    expect(controls.CloudAgentCredentialControlExchangeResponseSchema.safeParse({ ...value, controls: Array(17).fill(request) }).success).toBe(false);
    expect(controls.CloudAgentCredentialControlExchangeResponseSchema.safeParse({ ...value, confirmedRunning: true }).success).toBe(false);
  });
});
