import {describe,expect,it} from "vitest";
import {CloudQueuedPromptSchema} from "./commands.js";
import {CLOUD_AGENT_PERMISSION_MODES,CloudQueuedPromptSchema as WirePrompt} from "../../../../packages/protocol/src/cloud-commands.js";

const prompt={userMessageId:"message",prompt:[{type:"text",text:"test"}],modeRevision:0};
describe("queued provider permission contract",()=>{
  it.each(Object.entries(CLOUD_AGENT_PERMISSION_MODES).flatMap(([agentId,modes])=>modes.map(permissionMode=>({agentId,permissionMode}))))("preserves $agentId $permissionMode in both boundaries",selection=>{
    const input={...prompt,...selection};
    expect(CloudQueuedPromptSchema.parse(input)).toEqual(WirePrompt.parse(input));
  });
  it.each(["claude","codex","cursor"])("retains legacy %s commands without inventing a permission field",agentId=>{
    expect(CloudQueuedPromptSchema.parse({...prompt,agentId})).not.toHaveProperty("permissionMode");
  });
  it.each([["codex","bypass"],["claude","full-access"],["cursor","ask"],["codex","unknown"]])("rejects %s foreign permission %s",(agentId,permissionMode)=>{
    expect(CloudQueuedPromptSchema.safeParse({...prompt,agentId,permissionMode}).success).toBe(false);
  });
});
