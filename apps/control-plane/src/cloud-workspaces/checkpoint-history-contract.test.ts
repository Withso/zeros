import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CloudCheckpointHistorySnapshotSchema as Native } from "../../../../packages/protocol/src/cloud-checkpoint-history.js";
import { CloudCheckpointHistorySnapshotSchema as Server } from "./checkpoint-history-contract.js";
import * as Wire from "../../../../packages/protocol/src/cloud-agent-bootstrap.js";
import * as Standalone from "./agent-boot-contract.js";

const scope={organizationId:randomUUID(),workspaceId:randomUUID(),generation:2,engineInstanceId:randomUUID(),bootId:randomUUID(),
  writerEpoch:randomUUID(),fundingOwnerUserId:randomUUID(),fundingOwnerEpoch:1};
const snapshot=()=>({version:1,scope,origins:[{scope,recordSequence:5,eventSequence:9}],controls:[{conversationId:"chat",revision:1,paused:true}],
  commands:[],heads:[{conversationId:"chat",head:{originWriterEpoch:scope.writerEpoch,source:{kind:"mutation",mutationId:randomUUID(),operation:"delete"},
    deleted:true,history:{restoreRevision:1,recordSequence:5,eventSequence:9,incompleteReason:"capture_unavailable"}}}],documents:[]});

describe("checkpoint-only history wire",()=>{
  it("retains a closed unknown-coverage snapshot identically in native and standalone schemas",()=>{
    const value=snapshot();expect(Server.parse(value)).toEqual(Native.parse(value));
  });
  it.each(["payload","foreign","duplicate","origin","counter","unknown"])("refuses %s instead of widening authority",kind=>{
    const value:Record<string,unknown>=snapshot();
    if(kind==="payload")value.prompt="never admitted";
    if(kind==="foreign")value.origins=[{scope:{...scope,organizationId:randomUUID()},recordSequence:5,eventSequence:9}];
    if(kind==="duplicate")value.heads=[...(value.heads as object[]),...(value.heads as object[])];
    if(kind==="origin")value.origins=[];
    if(kind==="counter")value.origins=[{scope,recordSequence:5,eventSequence:-1}];
    if(kind==="unknown")value.complete=true;
    expect(Server.safeParse(value).success).toBe(false);expect(Native.safeParse(value).success).toBe(false);
  });
  it("adds only an explicit missing-ledger request and exact response to the existing private wire",()=>{
    const {writerEpoch:_writer,bootId:_boot,fundingOwnerEpoch:_epoch,fundingOwnerUserId:_owner,...engine}=scope;
    const request={...engine,version:1,mode:"boot-owner-v1",checkpointOnly:true};
    expect(Standalone.CloudAgentHistoryRecoveryRequestSchema.parse(request)).toEqual(Wire.CloudAgentHistoryRecoveryRequestSchema.parse(request));
    const response={...request,bootId:scope.bootId,fundingOwnerEpoch:1,fundingOwnerUserId:scope.fundingOwnerUserId,recoveryId:randomUUID(),
      code:"history_recovered_with_gap",coverage:"unknown",predecessor:scope,predecessorRetiredAt:new Date().toISOString(),mirroredSequence:1,
      checkpoint:{writerEpoch:randomUUID(),sha256:"a".repeat(64)},checkpointOnly:{ownerDiscardReceiptId:randomUUID(),checkpointId:randomUUID(),document:"{}",sha256:"b".repeat(64)}};
    expect(Standalone.CloudAgentHistoryRecoveryResponseSchema.parse(response)).toEqual(Wire.CloudAgentHistoryRecoveryResponseSchema.parse(response));
    for(const checkpointOnly of [false,{},"yes"]){expect(Standalone.CloudAgentHistoryRecoveryRequestSchema.safeParse({...request,checkpointOnly}).success).toBe(false);
      expect(Wire.CloudAgentHistoryRecoveryRequestSchema.safeParse({...request,checkpointOnly}).success).toBe(false);}
  });
});
