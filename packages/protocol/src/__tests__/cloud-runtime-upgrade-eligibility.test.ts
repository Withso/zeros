import { describe, expect, it } from "vitest";
import { CloudRuntimeUpgradeAvailabilitySchema } from "../cloud-runtime-lifecycle";
import { CloudRuntimeUpgradeEligibilitySchema, CloudRuntimeUpgradeEligibilityRequestSchema } from "../cloud-runtime-upgrade-eligibility";
import { CloudRuntimeUpgradeEligibilitySchema as Backend, CloudRuntimeUpgradeEligibilityRequestSchema as BackendRequest } from "../../../../apps/control-plane/src/cloud-workspaces/runtime-upgrade-eligibility-contract";

const organizationId="11111111-1111-4111-8111-111111111111",workspaceId="22222222-2222-4222-8222-222222222222";
const observedAt="2026-10-15T10:30:00.000Z",durableAt="2026-10-12T10:19:00.000Z";
const availability={organizationId,workspaceId,generation:1,currentRuntimeId:`r1-${"a".repeat(64)}`,
  latestRuntimeId:`r1-${"b".repeat(64)}`,updateAvailable:true,unavailableReason:null,transition:null};
const snapshot={version:1,organizationId,workspaceId,generation:1,observedAt,availability,
  recovery:{state:"acknowledgement_required",durableAt,reasons:["engine_started_after_checkpoint"]},
  lastDeferred:{generation:1,at:"2026-10-15T10:24:06.000Z",code:"recovery_acknowledgement_required"}};
const parsers=[CloudRuntimeUpgradeEligibilitySchema,Backend];
describe("read-only runtime upgrade prerequisites",()=>{
  it.each([
    snapshot,
    {...snapshot,recovery:{state:"lossless",durableAt,reasons:[]},lastDeferred:null},
    {...snapshot,recovery:{state:"not_required_until_stop",durableAt:null,reasons:[]}},
    {...snapshot,recovery:{state:"unavailable",durableAt:null,reasons:["checkpoint_unavailable"]}},
    {...snapshot,recovery:{state:"acknowledgement_required",durableAt,reasons:[
      "generation_changed","content_changed","records_changed","final_checkpoint_unproven",
      "engine_started_after_checkpoint","setup_completed_after_checkpoint"]}},
  ])("keeps the independent CP and renderer observation parsers aligned",value=>{
    expect(Backend.parse(value)).toEqual(CloudRuntimeUpgradeEligibilitySchema.parse(value));
  });
  it.each([
    {...snapshot,allowDataLoss:true},
    {...snapshot,admissionToken:"not-an-authority"},
    {...snapshot,availability:{...availability,organizationId:workspaceId}},
    {...snapshot,availability:{...availability,generation:2}},
    {...snapshot,lastDeferred:{...snapshot.lastDeferred,generation:2}},
    {...snapshot,lastDeferred:{...snapshot.lastDeferred,code:"raw_provider_failure"}},
    {...snapshot,recovery:{state:"lossless",durableAt,reasons:["engine_started_after_checkpoint"]}},
    {...snapshot,recovery:{state:"acknowledgement_required",durableAt,reasons:[]}},
    {...snapshot,recovery:{state:"acknowledgement_required",durableAt,reasons:["records_changed","content_changed"]}},
    {...snapshot,recovery:{state:"acknowledgement_required",durableAt,reasons:["content_changed","content_changed"]}},
    {...snapshot,recovery:{state:"acknowledgement_required",durableAt:null,reasons:["records_changed"]}},
    {...snapshot,recovery:{state:"unavailable",durableAt,reasons:["checkpoint_unavailable"]}},
    {...snapshot,recovery:{state:"not_required_until_stop",durableAt:null,reasons:["checkpoint_unavailable"]}},
  ])("rejects authority fields, foreign scope and inconsistent recovery evidence",value=>{
    for(const parser of parsers)expect(parser.safeParse(value).success).toBe(false);
  });
  it("keeps the released strict availability response separate for older desktops",()=>{
    expect(CloudRuntimeUpgradeAvailabilitySchema.parse(availability)).toEqual(availability);
    expect(CloudRuntimeUpgradeAvailabilitySchema.safeParse({...availability,recovery:snapshot.recovery}).success).toBe(false);
    expect(Backend.safeParse(availability).success).toBe(false);
  });
  it("pins the expected generation without accepting client-selected recovery authority",()=>{
    expect(BackendRequest.parse({expectedGeneration:1})).toEqual(CloudRuntimeUpgradeEligibilityRequestSchema.parse({expectedGeneration:1}));
    for(const value of [{expectedGeneration:0},{expectedGeneration:1.5},{expectedGeneration:1,allowDataLoss:true},{expectedGeneration:1,runtimeId:availability.latestRuntimeId}])
      for(const parser of [BackendRequest,CloudRuntimeUpgradeEligibilityRequestSchema])expect(parser.safeParse(value).success).toBe(false);
  });
});
