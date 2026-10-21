import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CloudAgentCredentialRemovalTargetSchema,
  CloudAgentCredentialRemovalPrepareSchema,
  CloudAgentCredentialRemovalDecisionSchema,
  CloudAgentCredentialRemovalOutcomeSchema,
} from "./agent-credential-mutations.js";

const org = randomUUID(), credential = randomUUID(), operationId = randomUUID();
const targets = [
  { kind: "remove-organization-credential", organizationId: org, credentialId: credential, expectedCredentialRevision: 1 },
  { kind: "revoke-credential", credentialId: credential, expectedCredentialRevision: 1 },
  { kind: "disconnect-provider", organizationId: org, provider: "codex", expectedConnectionRevision: 1 },
  ...(["local", "organization", "global"] as const).map(scope => ({ kind: "remove-dev-reference", organizationId: org,
    referenceId: credential, scope, expectedCredentialRevision: 1 })),
] as const;

describe("Settings credential removal wire", () => {
  it.each(targets)("keeps the exact source and scope of $kind", target => {
    expect(CloudAgentCredentialRemovalTargetSchema.parse(target)).toEqual(target);
    const request = { version: 1, operationId, target };
    expect(CloudAgentCredentialRemovalPrepareSchema.parse(request)).toEqual(request);
  });

  it.each(["ownerUserId", "actorUserId", "bootId", "writerEpoch", "confirmedRunning", "material", "activityCount"])(
    "refuses renderer authority or private data at %s", field => {
      expect(CloudAgentCredentialRemovalPrepareSchema.safeParse({ version: 1, operationId, target: targets[0], [field]: randomUUID() }).success).toBe(false);
      expect(CloudAgentCredentialRemovalTargetSchema.safeParse({ ...targets[0], [field]: randomUUID() }).success).toBe(false);
    },
  );

  it("never treats an organization association removal as a global revoke", () => {
    expect(CloudAgentCredentialRemovalTargetSchema.safeParse({ ...targets[0], scope: "global" }).success).toBe(false);
    expect(CloudAgentCredentialRemovalTargetSchema.safeParse({ ...targets[1], organizationId: org }).success).toBe(false);
    expect(CloudAgentCredentialRemovalTargetSchema.safeParse({ ...targets[2], credentialId: credential }).success).toBe(false);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1", null])("refuses unbounded target revision %s", revision => {
    expect(CloudAgentCredentialRemovalTargetSchema.safeParse({ ...targets[0], expectedCredentialRevision: revision }).success).toBe(false);
    expect(CloudAgentCredentialRemovalTargetSchema.safeParse({ ...targets[2], expectedConnectionRevision: revision }).success).toBe(false);
  });

  it.each(["confirm", "cancel"])("requires stable request identity for %s replay", () => {
    const decision = { version: 1, requestId: randomUUID(), expectedRevision: 1 };
    expect(CloudAgentCredentialRemovalDecisionSchema.parse(decision)).toEqual(decision);
    expect(CloudAgentCredentialRemovalDecisionSchema.safeParse({ version: 1, expectedRevision: 1 }).success).toBe(false);
    expect(CloudAgentCredentialRemovalDecisionSchema.safeParse({ ...decision, operationId }).success).toBe(false);
    expect(CloudAgentCredentialRemovalDecisionSchema.safeParse({ ...decision, confirmedRunning: false }).success).toBe(false);
  });

  it.each(["removed", "cancelled", "expired"])("keeps terminal %s distinct", state => {
    const outcome = { version: 1, state, operationId, revision: 2 };
    expect(CloudAgentCredentialRemovalOutcomeSchema.parse(outcome)).toEqual(outcome);
    expect(CloudAgentCredentialRemovalOutcomeSchema.safeParse({ ...outcome, confirmedRunning: false }).success).toBe(false);
    expect(CloudAgentCredentialRemovalOutcomeSchema.safeParse({ ...outcome, phase: "removing" }).success).toBe(false);
  });

  it("allows the running dialog only for positive server confirmation", () => {
    const outcome = { version: 1, state: "awaiting-confirmation", operationId, revision: 2,
      expiresAt: "2030-01-01T00:00:00.000Z", confirmedRunning: true };
    expect(CloudAgentCredentialRemovalOutcomeSchema.parse(outcome)).toEqual(outcome);
    for (const confirmedRunning of [false, null, undefined, 0, "true"])
      expect(CloudAgentCredentialRemovalOutcomeSchema.safeParse({ ...outcome, confirmedRunning }).success).toBe(false);
    expect(CloudAgentCredentialRemovalOutcomeSchema.safeParse({ ...outcome, expiresAt: "invalid" }).success).toBe(false);
  });

  it.each(["preparing", "removing", "cancelling"])("keeps pending %s from implying removal or running", phase => {
    const outcome = { version: 1, state: "pending", operationId, revision: 2, phase, retryAfterMs: 1000 };
    expect(CloudAgentCredentialRemovalOutcomeSchema.parse(outcome)).toEqual(outcome);
    expect(CloudAgentCredentialRemovalOutcomeSchema.safeParse({ ...outcome, confirmedRunning: true }).success).toBe(false);
    expect(CloudAgentCredentialRemovalOutcomeSchema.safeParse({ ...outcome, expiresAt: "2030-01-01T00:00:00.000Z" }).success).toBe(false);
  });

  it.each([99, 30001, 1000.5, "1000", null])("refuses pending retry bound %s", retryAfterMs => {
    expect(CloudAgentCredentialRemovalOutcomeSchema.safeParse({ version: 1, state: "pending", operationId,
      revision: 2, phase: "removing", retryAfterMs }).success).toBe(false);
  });

  it.each(["activityCount", "proofId", "selectors", "material", "engineInstanceId"])("keeps private %s outside outcomes", field => {
    expect(CloudAgentCredentialRemovalOutcomeSchema.safeParse({ version: 1, state: "removed", operationId, revision: 2,
      [field]: "synthetic-private-field" }).success).toBe(false);
  });

  it.each(["failed", "idle", "stopped", "confirmed", "unknown"])("refuses invented public state %s", state => {
    expect(CloudAgentCredentialRemovalOutcomeSchema.safeParse({ version: 1, state, operationId, revision: 2 }).success).toBe(false);
  });
});
