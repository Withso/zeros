import { expect, it } from "vitest";
import { setupEvidenceSchema as protocol, setupObservationsSchema, setupEngineStartupSchema, setupErrorCodes, setupAttesterStages, setupAttesterChecks } from "../../packages/protocol/src/cloud-setup-evidence";
import { setupEvidenceSchema as control, setupErrorCodes as controlCodes } from "../../apps/control-plane/src/cloud-workspaces/setup-evidence-schema";
import { setupEngineStartupSchema as controlStartup, setupAttesterStages as controlAttesterStages, setupAttesterChecks as controlAttesterChecks } from "../../apps/control-plane/src/cloud-workspaces/cloud-diagnostics";
import { parseSetupObservations as controlObservations } from "../../apps/control-plane/src/cloud-workspaces/setup-observations";
import { parseSetupObservations as helperObservations, setupPreparationOutcomes, setupReadinessObservations } from "../cloud-workspace-validation/sandbox/cloud-setup-timings.mjs";
import { readSetupProgress } from "../zeros-dev/setup-observation";
import { CLOUD_V4_ATTESTER_STAGES, CLOUD_V4_ATTESTER_CHECKS } from "../cloud-workspace-validation/sandbox/attest-cloud-worker.mjs";
import { fixtureSetupEvidence } from "./zeros-dev-setup-fixture";

it("keeps closed helper observations and engine failures in parity across standalone readers", () => {
  expect(setupErrorCodes).toEqual(controlCodes);
  expect(setupAttesterStages).toEqual(controlAttesterStages);
  expect(setupAttesterStages).toEqual(CLOUD_V4_ATTESTER_STAGES);
  expect(setupAttesterChecks).toEqual(controlAttesterChecks);
  expect(setupAttesterChecks).toEqual(CLOUD_V4_ATTESTER_CHECKS);
  for (const field of ["phase", "name", "code"] as const) expect(setupEngineStartupSchema.shape[field].options).toEqual(controlStartup.shape[field].options);
  for (const preparation of setupPreparationOutcomes) for (const readiness of setupReadinessObservations) {
    const value = { version: 1, preparation, readiness };
    expect(setupObservationsSchema.parse(value)).toEqual(value);
    expect(controlObservations(value)).toEqual(value); expect(helperObservations(value)).toEqual(value);
  }
  for (const value of [null, {}, { version: 2 }, { version: 1, private: "synthetic" }, { version: 1, preparation: "synthetic" },
    { version: 1, readiness: "synthetic" }, { version: 1, preparation: ["reused"] }]) {
    expect(setupObservationsSchema.safeParse(value).success).toBe(false);
    expect(controlObservations(value)).toBeUndefined(); expect(helperObservations(value)).toBeUndefined();
  }
});

it("retains nested clock provenance and rejects unbounded, duplicate or unreviewed evidence in both readers", () => {
  const value = fixtureSetupEvidence();
  for (const schema of [control, protocol]) {
    expect(schema.parse(value)).toEqual(value);
    for (const input of [{ ...value, private: "synthetic" }, { ...value, createdAt: "2026-02-30T00:00:00.000Z" },
      { ...value, claims: [value.claims[0], value.claims[0]] }, { ...value, claims: Array(6).fill(value.claims[0]) },
      { ...value, claims: [{ ...value.claims[0], observations: { version: 1, preparation: "synthetic" } }] },
      { ...value, claims: [{ ...value.claims[0], failure: { code: "synthetic", phase: "engine_readiness", retryable: true } }] },
      { ...value, claims: [{ ...value.claims[0], engine: { ...value.claims[0].engine, bridgeToken: "synthetic" } }] },
      { ...value, executionFence: 0 }, { ...value, claimCount: 0 }]) expect(schema.safeParse(input).success).toBe(false);
  }
});

it("drops foreign, stale and invalid evidence without discarding ordinary setup progress", () => {
  const evidence = fixtureSetupEvidence(), progress = { generation: 1, attempt: 1, claimCount: 1, state: "succeeded", errorCode: null };
  const { generation: _generation, ...expected } = progress;
  expect(readSetupProgress(progress, 1, evidence, evidence.workspaceId)).toEqual({ ...expected, evidence });
  for (const value of [{ ...evidence, workspaceId: "11111111-1111-4111-8111-111111111111" }, { ...evidence, generation: 2 },
    { ...evidence, attempt: 2 }, { ...evidence, claimCount: 2 }, { ...evidence, state: "failed" }, { ...evidence, private: "synthetic" }])
    expect(readSetupProgress(progress, 1, value, evidence.workspaceId)).toEqual(expected);
  expect(readSetupProgress(progress, 1, evidence)).toEqual(expected);
});

it("carries a closed attester refusal through both evidence readers and canary progress", () => {
  const fixture = fixtureSetupEvidence(), attester = { stage: "qualify_engine", failedChecks: ["seccomp"] };
  const evidence = { ...fixture, state: "failed", claims: [{ ...fixture.claims[0], outcome: "failed",
    failure: { code: "setup_image_contract_invalid", phase: "image_preflight", retryable: false, attester } }] };
  for (const schema of [control, protocol]) {
    expect(schema.parse(evidence)).toEqual(evidence);
    for (const invalid of [{ ...attester, stage: "private-canary" }, { ...attester, failedChecks: ["private-canary"] },
      { ...attester, failedChecks: ["seccomp", "seccomp"] }, { ...attester, body: "private-canary" }])
      expect(schema.safeParse({ ...evidence, claims: [{ ...evidence.claims[0],
        failure: { ...evidence.claims[0].failure, attester: invalid } }] }).success).toBe(false);
  }
  const progress = { generation: 1, attempt: 1, claimCount: 1, state: "failed", errorCode: "setup_image_contract_invalid" };
  expect(readSetupProgress(progress, 1, evidence, evidence.workspaceId)?.evidence).toEqual(evidence);
});
