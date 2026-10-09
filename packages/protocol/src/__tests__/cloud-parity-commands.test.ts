import { describe, expect, it } from "vitest";
import {CloudCommandMutationSchema,CloudQueuedPromptSchema,CloudNativeResultSchema,CloudCommandEntrySchema,CloudCommandSnapshotSchema,legacyCloudCommandResponse} from "../cloud-commands";
const commandId = "22222222-2222-4222-8222-222222222222";
const payload = { agentId: "codex", userMessageId: "message", prompt: [{ type: "text", text: "" }], modeRevision: 0, model: "qualified-model", agentCredentialGrantId: commandId };
describe("versioned cloud native commands", () => {
  it("projects direct and snapshot results for strict old native-v1 clients without mutating durable terminals",()=>{
    const oldResult=CloudNativeResultSchema.omit({terminal:true});
    const oldEntry=CloudCommandEntrySchema.extend({result:oldResult.nullable().optional()});
    const oldSnapshot=CloudCommandSnapshotSchema.extend({pending:oldEntry.array(),receipts:oldEntry.array()});
    const terminal={commandId,conversationId:"source",executionId:"execution",turnId:"turn",agentId:"codex",status:"completed",stopReason:"end_turn"};
    const result={version:1,model:"qualified-model",capabilities:{version:1,goals:true,nativeFork:true,transcriptFork:true,nativeReview:true,connectedApps:true,multiAgent:true},
      goal:{objective:"Finish the task",status:"active",tokenBudget:100,tokensUsed:2,timeUsedSeconds:3,createdAt:1,updatedAt:2},terminal};
    const entry=CloudCommandEntrySchema.parse({commandId,position:1,state:"succeeded",payload:{...payload,operation:{version:1,kind:"goal",action:"get"}},executionId:"execution",generation:1,
      resultCode:null,createdAt:"2026-10-08T00:00:00Z",updatedAt:"2026-10-08T00:00:00Z",result});
    const snapshot=CloudCommandSnapshotSchema.parse({version:1,conversationId:"source",revision:1,paused:false,pending:[entry],receipts:[entry],nativeGoal:{version:1,conversationId:"source",revision:1,goal:result.goal}});
    expect(oldEntry.safeParse(entry).success).toBe(false);
    const projected=oldEntry.parse(legacyCloudCommandResponse(entry,1));
    expect(projected).toEqual({...entry,result:oldResult.parse({version:1,model:result.model,capabilities:result.capabilities,goal:result.goal})});expect(projected.payload).toEqual(entry.payload);
    const projectedSnapshot=oldSnapshot.parse(legacyCloudCommandResponse(snapshot,1));
    expect(projectedSnapshot.pending).toEqual([projected]);expect(projectedSnapshot.receipts).toEqual([projected]);expect(projectedSnapshot.nativeGoal).toEqual(snapshot.nativeGoal);
    expect(snapshot.pending[0]!.result!.terminal).toEqual(terminal);expect(snapshot.receipts[0]!.result!.terminal).toEqual(terminal);
    const{result:_result,...legacyEntry}=entry;
    expect(legacyCloudCommandResponse(entry)).toEqual({...legacyEntry,payload:null});expect(legacyCloudCommandResponse(entry)).not.toHaveProperty("result");
    const legacy=legacyCloudCommandResponse(snapshot) as {nativeGoal?:unknown;pending:unknown[];receipts:unknown[]};
    expect(legacy).not.toHaveProperty("nativeGoal");expect(legacy.pending).toEqual([legacyCloudCommandResponse(entry)]);expect(legacy.receipts).toEqual(legacy.pending);
  });
  it("accepts a durable fork with explicit source and destination", () => {
    const mutation = { conversationId: "destination", operationId: commandId, expectedRevision: 0,
      action: { kind: "fork", commandId, payload: { ...payload, operation: { version: 1, kind: "fork", sourceConversationId: "source", strategy: "native" } } } };
    expect(CloudCommandMutationSchema.parse(mutation)).toEqual(mutation);
    expect(CloudCommandMutationSchema.safeParse({ ...mutation, conversationId: "source" }).success).toBe(false);
  });
  it.each(["get", "clear", "set"])("accepts typed goal %s", action => {
    const input = { ...payload, operation: { version: 1, kind: "goal", action, ...(action === "set" ? { update: { objective: "Finish the task" } } : {}) } };
    expect(CloudQueuedPromptSchema.parse(input)).toEqual(input);
    expect(CloudQueuedPromptSchema.safeParse({ ...input, agentId: "claude" }).success).toBe(false);
  });
});
