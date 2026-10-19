import { describe, expect, it } from "vitest";
import * as cp from "./final-save-contract.js";
import * as shared from "../../../../packages/protocol/src/cloud-final-save.js";

const id = "11111111-1111-4111-8111-111111111111";
const digest = "a".repeat(64);
const source = { organizationId:id,workspaceId:id,generation:1,engineInstanceId:id,runtimeId:`r1-${digest}`,
  bootId:id,writerEpoch:id,fundingOwnerUserId:id,fundingOwnerEpoch:1,authorityEpoch:1,registeredAtMs:1,
  allocationLeaseId:id,providerResourceId:"fixture-resource" };
const attempt = { version:1,recoveryId:id,requestId:id,attemptOrdinal:0,sourceSha256:digest,custodyId:id };
const request = { ...attempt,organizationId:id,workspaceId:id,generation:1,engineInstanceId:id,kind:"retry",failure:"capture_failed",commit:null };
const directive = { version:1,recoveryId:id,attemptOrdinal:0,predecessorRequestId:null,source,sourceSha256:digest,custodyId:null,retirementId:null };
const receipt = { version:1,id,kind:"restart",sourceGeneration:1 };

describe("final-save canonical and standalone CP wire", () => {
  it.each([
    ["CloudFinalSaveSourceSchema", source],
    ["CloudFinalSaveDirectiveSchema", directive],
    ["CloudFinalSaveDirectiveSchema", {...directive,attemptOrdinal:1,predecessorRequestId:id,custodyId:id,retirementId:id}],
    ["CloudFinalSaveCommitSchema", {idempotencyKey:"checkpoint.fixture",requestSha256:digest,bodySha256:digest}],
    ["CloudFinalSaveRequestSchema", request],
    ["CloudFinalSaveResponseSchema", {...attempt,state:"waiting",retryAtMs:1}],
    ["CloudFinalSaveResponseSchema", {...attempt,state:"retired",retirementId:id,retryAtMs:1}],
    ["CloudFinalSaveResponseSchema", {...attempt,state:"blocked",reason:"authority",retryAtMs:1}],
    ["CloudFinalSaveResponseSchema", {...attempt,state:"committed",checkpoint:{checkpointId:id,contentRevision:1,manifestSha256:digest,reason:"before_stop",requestSha256:digest}}],
    ["CloudAcceptedLifecycleReceiptSchema", receipt],
    ["CloudAcceptedLifecycleOperationSchema", {...receipt,phase:"saving",state:"pending"}],
    ["CloudRestartInputSchema", {version:1,expectedGeneration:1}],
  ] as const)("keeps %s valid and closed", (name, input) => {
    expect(cp[name].parse(input)).toEqual(shared[name].parse(input));
    for (const schema of [cp[name],shared[name]]) expect(schema.safeParse({...input,token:"rejected"}).success).toBe(false);
  });
  it.each([
    ["CloudFinalSaveSourceSchema", {...source,writerEpoch:1}],
    ["CloudFinalSaveSourceSchema", {...source,providerResourceId:"x".repeat(257)}],
    ["CloudFinalSaveDirectiveSchema", {...directive,attemptOrdinal:1}],
    ["CloudFinalSaveDirectiveSchema", {...directive,custodyId:id}],
    ["CloudFinalSaveRequestSchema", {...request,failure:"commit_ambiguous"}],
    ["CloudFinalSaveRequestSchema", {...request,attemptOrdinal:-1}],
    ["CloudFinalSaveResponseSchema", {...attempt,state:"blocked",reason:"provider text",retryAtMs:1}],
    ["CloudFinalSaveResponseSchema", {...attempt,state:"committed",checkpoint:{checkpointId:id}}],
    ["CloudAcceptedLifecycleOperationSchema", {...receipt,phase:"completed",state:"pending"}],
    ["CloudAcceptedLifecycleOperationSchema", {...receipt,kind:"stop",phase:"starting",state:"pending"}],
    ["CloudAcceptedLifecycleOperationSchema", {...receipt,kind:"delete",phase:"archiving",state:"pending"}],
    ["CloudAcceptedLifecycleOperationSchema", {...receipt,kind:"archive",phase:"deleting",state:"pending"}],
    ["CloudAcceptedLifecycleOperationSchema", {...receipt,phase:"saving",state:"completed"}],
    ["CloudRestartInputSchema", {version:1,expectedGeneration:0}],
  ] as const)("refuses incompatible %s shapes", (name, input) => {
    expect(cp[name].safeParse(input).success).toBe(false);
    expect(shared[name].safeParse(input).success).toBe(false);
  });
  it("pins source hashing and protocol constants without normalizing the exact commit bytes", () => {
    expect(cp.canonicalFinalSaveSource(source)).toBe(shared.canonicalFinalSaveSource(source));
    expect(cp.canonicalFinalSaveSource(Object.fromEntries(Object.entries(source).reverse()))).toBe(cp.canonicalFinalSaveSource(source));
    for (const key of ["CLOUD_FINAL_SAVE_PATH","CLOUD_FINAL_SAVE_MAX_BYTES","CLOUD_FINAL_SAVE_VERSION_HEADER"] as const)
      expect(cp[key]).toBe(shared[key]);
  });
});
