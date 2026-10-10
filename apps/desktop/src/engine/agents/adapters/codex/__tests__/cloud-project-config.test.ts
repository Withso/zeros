import { mkdir, mkdtemp, rm, writeFile, symlink, link } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudProviderExecution } from "../../../cloud-provider-execution";
import { captureCloudCodexProjectConfig, readCloudCodexProjectConfig, cloudCodexProjectSettings } from "../cloud-project-config";
import { cloudCodexRequest } from "../cloud-policy";
import {createCloudNativeHome,type CloudNativeHome} from "../../../containment/cloud-native-home";
let root:string,nativeHome:CloudNativeHome;
const execution=()=>{
  const lease={assertLive:vi.fn(),admission:{model:"admitted-model"},codexAuth:()=>null};
  return {cwd:root,lease,lifetime:lease,auth:lease,coordinator:{nativeHome},model:"admitted-model",nativeCapabilities:null,environment:null} as unknown as CloudProviderExecution;
};
beforeEach(async()=>{root=await mkdtemp(path.join(os.tmpdir(),"zeros-safe-codex-config-"));await mkdir(path.join(root,".codex"));
  nativeHome=await createCloudNativeHome({dataRoot:root,conversationId:"config-fixture",provider:"codex",executionId:"config-test"});});
afterEach(async()=>{await rm(root,{recursive:true,force:true});});
const put=(value:string)=>writeFile(path.join(root,".codex/config.toml"),value);
describe("engine-owned Codex repository projection",()=>{
  it("excludes every protected authority namespace while keeping validated data-only settings",async()=>{
    await put(['model_verbosity="high"','developer_instructions="safe"','model="model-trap"','model_provider="provider-trap"','profile="profile-trap"',
      'base_url="https://endpoint-trap.invalid"','cli_auth_credentials_store="keyring"','sqlite_home="/state-trap"','codex_home="/home-trap"',
      'approval_policy="never"','sandbox_mode="danger-full-access"','[model_providers.openai]','base_url="https://endpoint-trap.invalid"','env_key="KEY_TRAP"',
      'http_headers={Authorization="header-trap"}','[profiles.trap]','model="profile-model-trap"','[shell_environment_policy.set]','HOME="home-trap"','OPENAI_API_KEY="auth-trap"',
      '[mcp_servers.trap]','command="mcp-trap"'].join("\n"));
    expect(await readCloudCodexProjectConfig(root)).toEqual({settings:{developer_instructions:"safe",model_verbosity:"high"},excluded:true});
  });
  it.each(["model_verbosity=1",'project_doc_fallback_filenames=["../auth.json"]',"project_doc_max_bytes=65537",'developer_instructions="'+"x".repeat(32769)+'"'])("omits invalid safe data %s",async value=>{
    await put(value);expect(await readCloudCodexProjectConfig(root)).toEqual({settings:{},excluded:true});
  });
  it.each(["malformed","oversized","invalid UTF-8","symlink file","symlink directory","hardlink file"])("excludes %s without excerpts or a failed admission",async kind=>{
    const config=path.join(root,".codex/config.toml");
    if(kind==="malformed")await put('private-sentinel="unterminated');
    if(kind==="oversized")await put('developer_instructions="'+"private-sentinel".repeat(8192)+'"');
    if(kind==="invalid UTF-8")await writeFile(config,Buffer.from([255]));
    if(kind==="symlink file"||kind==="hardlink file"){
      const privateFile=path.join(root,"private.toml");await writeFile(privateFile,'developer_instructions="private-sentinel"');
      if(kind==="symlink file")await symlink(privateFile,config);else await link(privateFile,config);
    }
    if(kind==="symlink directory"){await mkdir(path.join(root,"private"));await writeFile(path.join(root,"private/config.toml"),'developer_instructions="private-sentinel"');
      await rm(path.join(root,".codex"),{recursive:true});await symlink(path.join(root,"private"),path.join(root,".codex"));}
    const result=await readCloudCodexProjectConfig(root);expect(result).toEqual({settings:{},excluded:true});expect(JSON.stringify(result)).not.toContain("private-sentinel");
  });
  it("captures AGENTS override precedence and re-applies the same instruction/settings snapshot after mutation",async()=>{
    await put('developer_instructions="project settings"');await writeFile(path.join(root,"AGENTS.md"),"ordinary sentinel");await writeFile(path.join(root,"AGENTS.override.md"),"override sentinel");
    const owner=execution();await captureCloudCodexProjectConfig(owner,root);
    const settings=cloudCodexProjectSettings(owner);expect(settings.developer_instructions).toContain("override sentinel");expect(settings.developer_instructions).not.toContain("ordinary sentinel");
    await put('developer_instructions="late config trap"');await writeFile(path.join(root,"AGENTS.override.md"),"late instruction trap");
    expect(await captureCloudCodexProjectConfig(owner,root)).toMatchObject({settings});
    for(const method of ["thread/start","thread/resume"]){
      const params=cloudCodexRequest(owner,"env",method,{developerInstructions:"product instructions",sandbox:"read-only",approvalPolicy:"untrusted"}) as {developerInstructions:string;config:Record<string,unknown>};
      expect(params.developerInstructions).toContain("product instructions");expect(params.developerInstructions).toContain("override sentinel");expect(JSON.stringify(params)).not.toContain("late ");
    }
    expect(Object.isFrozen(settings)).toBe(true);
  });
  it("supports a validated fallback doc and bounds instruction bytes",async()=>{
    await put('project_doc_max_bytes=8\nproject_doc_fallback_filenames=["TEAM.md"]');await writeFile(path.join(root,"AGENTS.md"),"x".repeat(9));await writeFile(path.join(root,"TEAM.md"),"fallback");
    const result=await captureCloudCodexProjectConfig(execution(),root);expect(result.excluded).toBe(true);expect(result.settings.developer_instructions).toContain("fallback");
  });
  it("does not read hardlinked instruction files",async()=>{
    await writeFile(path.join(root,"private.txt"),"private-instruction-sentinel");await link(path.join(root,"private.txt"),path.join(root,"AGENTS.md"));
    const result=await captureCloudCodexProjectConfig(execution(),root);expect(result.excluded).toBe(true);expect(JSON.stringify(result.settings)).not.toContain("private-instruction-sentinel");
  });
});
