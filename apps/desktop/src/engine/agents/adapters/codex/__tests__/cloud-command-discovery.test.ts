import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudProviderExecution } from "../../../cloud-provider-execution";
const harness=vi.hoisted(()=>({execution:null as CloudProviderExecution|null}));
vi.mock("../../../cloud-provider-execution",async importOriginal=>({
  ...await importOriginal<typeof import("../../../cloud-provider-execution")>(),
  cloudProviderExecution:()=>harness.execution,executionMcpServers:()=>[],
}));
import { CodexAppServerAdapter, type CodexSession } from "../app-server-adapter";
const refresh=(CodexAppServerAdapter.prototype as unknown as {refreshCommands(this:unknown,session:CodexSession):Promise<void>}).refreshCommands;
let root:string,repo:string,home:string;
beforeEach(async()=>{
  root=await mkdtemp(path.join(os.tmpdir(),"zeros-codex-discovery-"));repo=path.join(root,"repo");home=path.join(root,"engine-home");
  await mkdir(path.join(repo,".codex/prompts"),{recursive:true});await mkdir(path.join(home,".codex/prompts"),{recursive:true});
  await writeFile(path.join(repo,".codex/prompts/project.md"),"---\ndescription: Repository command sentinel\n---\nDo the project task.");
  await writeFile(path.join(home,".codex/prompts/engine-private.md"),"Engine private command sentinel");
  vi.spyOn(os,"homedir").mockReturnValue(home);vi.stubEnv("CODEX_HOME",path.join(home,".codex"));
  const lifetime={assertLive:vi.fn()};
  harness.execution={mode:"actor-grant-v1",cwd:repo,lease:lifetime,lifetime} as unknown as CloudProviderExecution;
});
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();await rm(root,{recursive:true,force:true});});
async function commands(cwd:string){
  const emit=vi.fn();await refresh.call({agentId:"codex",ctx:{emit:{onSessionUpdate:emit}},discoverSkills:async()=>[]},
    {cwd,zerosSessionId:"session",executionBoundary:{}} as CodexSession);
  return emit.mock.calls[0][1].update.availableCommands;
}
describe("cloud repository command discovery",()=>{
  it("uses trusted execution.cwd and never scans the engine's Codex HOME",async()=>{
    expect(await commands("/private/caller")).toEqual([{name:"project",description:"Repository command sentinel",kind:"command"}]);
  });
  it("keeps Local user-home plus repository command precedence",async()=>{
    harness.execution=null;expect((await commands(repo)).map((row:{name:string})=>row.name)).toEqual(["engine-private","project"]);
  });
});
