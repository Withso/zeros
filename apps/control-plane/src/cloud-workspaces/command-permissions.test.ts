import {describe,expect,it} from "vitest";
import {CloudGoalUpdateSchema,CloudNativeOperationSchema,CloudQueuedPromptSchema} from "./commands.js";
import {CLOUD_AGENT_PERMISSION_MODES,CloudGoalUpdateSchema as WireGoalUpdate,CloudNativeOperationSchema as WireOperation,CloudQueuedPromptSchema as WirePrompt} from "../../../../packages/protocol/src/cloud-commands.js";

const prompt={userMessageId:"message",prompt:[{type:"text",text:"test"}],modeRevision:0};
describe("queued provider permission contract",()=>{
  it("mirrors provider goal origin while rejecting client-authored provenance", () => {
    for (const schema of [CloudGoalUpdateSchema, WireGoalUpdate]) {
      expect(schema.parse({ objective: "Finish", origin: "user" })).toEqual({ objective: "Finish", origin: "user" });
      expect(schema.safeParse({ origin: "user" }).success).toBe(false);
      expect(schema.safeParse({ objective: "Finish", origin: "forged" }).success).toBe(false);
    }
    for (const schema of [CloudNativeOperationSchema, WireOperation]) {
      for (const origin of ["user", "automatic", null]) {
        expect(schema.safeParse({ version: 1, kind: "goal", action: "set", update: { objective: "Finish", origin } }).success).toBe(false);
        expect(schema.safeParse({ version: 1, kind: "goal", action: "clear", origin }).success).toBe(false);
      }
    }
  });
  it.each([false, true].flatMap(autoMemoryEnabled => [false, true].map(idleCompactionEnabled => ({ autoMemoryEnabled, idleCompactionEnabled }))))
  ("preserves Claude preferences in the independently deployed schema (%j)", claudePreferences => {
    const input = { ...prompt, agentId: "claude", claudePreferences };
    expect(CloudQueuedPromptSchema.parse(input)).toEqual(WirePrompt.parse(input));
  });
  it.each([
    { autoMemoryEnabled: "false", idleCompactionEnabled: false },
    { autoMemoryEnabled: false, idleCompactionEnabled: 1 },
    { autoMemoryEnabled: false },
    { autoMemoryEnabled: false, idleCompactionEnabled: false, settings: {} },
  ])("rejects malformed or extended Claude preferences at both boundaries (%j)", claudePreferences => {
    for (const schema of [CloudQueuedPromptSchema, WirePrompt])
      expect(schema.safeParse({ ...prompt, agentId: "claude", claudePreferences }).success).toBe(false);
  });
  it.each(["codex", "cursor"])("rejects Claude preferences on a %s command at both boundaries", agentId => {
    for (const schema of [CloudQueuedPromptSchema, WirePrompt])
      expect(schema.safeParse({ ...prompt, agentId, claudePreferences: { autoMemoryEnabled: false, idleCompactionEnabled: true } }).success).toBe(false);
  });
  it.each(Object.entries(CLOUD_AGENT_PERMISSION_MODES).flatMap(([agentId,modes])=>modes.map(permissionMode=>({agentId,permissionMode}))))("preserves $agentId $permissionMode in both boundaries",selection=>{
    const input={...prompt,...selection};
    expect(CloudQueuedPromptSchema.parse(input)).toEqual(WirePrompt.parse(input));
  });
  it.each(["claude","codex","cursor"])("retains legacy %s commands without inventing a permission field",agentId=>{
    const input = { ...prompt, agentId };
    expect(CloudQueuedPromptSchema.parse(input)).toEqual(WirePrompt.parse(input));
    expect(CloudQueuedPromptSchema.parse(input)).not.toHaveProperty("permissionMode");
    expect(CloudQueuedPromptSchema.parse(input)).not.toHaveProperty("claudePreferences");
  });
  it.each([["codex","bypass"],["claude","full-access"],["cursor","ask"],["codex","unknown"]])("rejects %s foreign permission %s",(agentId,permissionMode)=>{
    expect(CloudQueuedPromptSchema.safeParse({...prompt,agentId,permissionMode}).success).toBe(false);
  });
});
