import {describe,expect,it} from "vitest";
import {CloudAgentModelSchema} from "./agent-credentials.js";
import {CloudQueuedPromptSchema} from "./commands.js";

describe("cloud model admission parity",()=>{
  it("keeps a context-qualified model through credential and command admission",()=>{
    const model="claude-opus-5[1m]";
    expect(CloudAgentModelSchema.parse(model)).toBe(model);
    expect(CloudQueuedPromptSchema.parse({agentId:"claude",userMessageId:"message",prompt:[{type:"text",text:"test"}],modeRevision:0,model}).model).toBe(model);
  });
  it.each(["*","claude[1m][1m]","claude[anything]","bad\nmodel","a".repeat(257),`${"a".repeat(253)}[1m]`])("rejects invalid model %j",model=>{
    expect(CloudAgentModelSchema.safeParse(model).success).toBe(false);
  });
});
