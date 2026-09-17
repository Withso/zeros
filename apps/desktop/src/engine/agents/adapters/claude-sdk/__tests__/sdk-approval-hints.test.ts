import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { query } from "@anthropic-ai/claude-agent-sdk";

// Exercise the installed public wrapper, not a mocked canUseTool callback.
// A tiny offline CLI emits native hints. Keep this coverage when upgrading so
// a wrapper regression cannot silently widen an explicit Yes/No decision.
const cli = `
const {createInterface}=require('node:readline');
const send=message=>process.stdout.write(JSON.stringify(message)+'\\n');
const keepAlive=setInterval(()=>{},1000);
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.type==='control_request') send({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{}}});
 if(m.type==='user') send({type:'control_request',request_id:'approval',request:{subtype:'can_use_tool',tool_name:'Bash',tool_use_id:'tool',input:{command:'pwd'},default_to_no:true,suppress_always_allow_rule:true}});
 if(m.type==='control_response' && m.response.request_id==='approval') {
  send({type:'result',subtype:'success',uuid:'result',session_id:'offline',is_error:false,result:'Done',num_turns:0});
  clearInterval(keepAlive); process.stdin.destroy();
 }
});`;

describe("installed Claude SDK approval hints", () => {
  it("forwards both native hints to the host callback", async () => {
    const canUseTool = vi.fn(async () => ({
      behavior: "deny" as const,
      message: "Fixture declined",
    }));
    const run = query({
      prompt: "Offline permission fixture",
      options: {
        canUseTool,
        spawnClaudeCodeProcess: () =>
          spawn(process.execPath, ["-e", cli], {
            stdio: ["pipe", "pipe", "pipe"],
          }),
      },
    });
    try {
      for await (const message of run) {
        if (message.type === "result") break;
      }
      expect(canUseTool).toHaveBeenCalledWith(
        "Bash",
        { command: "pwd" },
        expect.objectContaining({
          defaultToNo: true,
          suppressAlwaysAllowRule: true,
        }),
      );
    } finally {
      run.close();
    }
  }, 10_000);
});
