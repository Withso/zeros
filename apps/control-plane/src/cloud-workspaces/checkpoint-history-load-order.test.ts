import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Importing the snapshot first hid a service -> recovery -> contract -> service
// cycle. Each entry below starts with a fresh module registry, as a CI shard or
// standalone process can; a load failure is an assertion, not a skipped suite.
const entries={
  commands:()=>import("./commands.js"),
  routes:()=>import("./command-routes.js"),
  history:()=>import("./history.js"),
  boot:()=>import("./agent-boot-credentials.js"),
  recovery:()=>import("./agent-history-recovery.js"),
  snapshot:()=>import("./checkpoint-history.js"),
  contract:()=>import("./checkpoint-history-contract.js"),
};
describe("checkpoint history loads independently of the first service",()=>{
  beforeEach(()=>vi.resetModules());
  it.each(Object.keys(entries) as (keyof typeof entries)[])("loads %s first and keeps the closed receipt schema",async entry=>{
    await expect(entries[entry]()).resolves.toBeDefined();
    const {CloudCheckpointHistorySnapshotSchema}=await import("./checkpoint-history-contract.js");
    const {CloudBootCommandEntrySchema}=await import("./commands.js");
    const scope={organizationId:randomUUID(),workspaceId:randomUUID(),generation:2,engineInstanceId:randomUUID(),
      bootId:randomUUID(),writerEpoch:randomUUID(),fundingOwnerUserId:randomUUID(),fundingOwnerEpoch:1};
    const receipt={commandId:randomUUID(),position:1,state:"cancelled",executionId:null,generation:2,resultCode:"cancelled",
      createdAt:"2026-01-01T00:00:00.000Z",updatedAt:"2026-01-01T00:00:00.000Z"};
    expect(CloudBootCommandEntrySchema.parse({...receipt,payload:null})).toEqual({...receipt,payload:null});
    const command={conversationId:"chat",originWriterEpoch:scope.writerEpoch,entry:receipt,
      intent:{userMessageId:"message",agentId:"claude"},actor:null,credentialRun:null,
      history:{restoreRevision:1,recordSequence:5,eventSequence:9,incompleteReason:"capture_unavailable"}};
    const snapshot={version:1,scope,origins:[{scope,recordSequence:5,eventSequence:9}],controls:[],commands:[command],heads:[],documents:[]};
    expect(CloudCheckpointHistorySnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(CloudCheckpointHistorySnapshotSchema.safeParse({...snapshot,
      commands:[{...command,entry:{...receipt,payload:null}}]}).success).toBe(false);
    expect(CloudCheckpointHistorySnapshotSchema.safeParse({...snapshot,complete:true}).success).toBe(false);
  });
});
