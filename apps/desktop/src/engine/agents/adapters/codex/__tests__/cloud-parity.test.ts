import { afterEach,beforeEach,describe, expect, it, vi } from "vitest";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {createCloudNativeHome,type CloudNativeHome} from "../../../containment/cloud-native-home";
let dataRoot:string, nativeHome:CloudNativeHome;
beforeEach(async()=>{dataRoot=await mkdtemp(path.join(tmpdir(),"zeros-codex-parity-"));nativeHome=await createCloudNativeHome({dataRoot,conversationId:"original-conversation",provider:"codex",executionId:"original-execution"});});
afterEach(async()=>{await rm(dataRoot,{recursive:true,force:true});});
import type { CloudProviderExecution } from "../../../cloud-provider-execution";
import { bindCloudCodexThread, cloudCodexCapabilities, cloudCodexConfig, cloudCodexRequest } from "../cloud-policy";

function execution(apps = false) {
  const lease={assertLive:vi.fn(),codexAuth:()=>apps?{material:{accountId:"selected-account"}}:null};
  return {cwd:"/srv/zeros/workspace",coordinator:{nativeHome},lease,lifetime:lease,auth:lease,model:"qualified-model",
    nativeCapabilities:{version:1,goals:true,nativeReview:true,nativeFork:true,multiAgent:true,connectedApps:true},environment:null} as unknown as CloudProviderExecution;
}
describe("admitted Codex cloud extensions", () => {
  it("admits goal set/get/clear for the execution's exact native conversation", () => {
    const owner = execution(); bindCloudCodexThread(owner, "own-thread");
    for (const method of ["thread/goal/set", "thread/goal/get", "thread/goal/clear"]) {
      const input = { threadId: "own-thread", ...(method.endsWith("set") ? { objective: "Complete the task", tokenBudget: 1000 } : {}) };
      expect(cloudCodexRequest(owner, "env", method, input)).toEqual(input);
      expect(() => cloudCodexRequest(owner, "env", method, { ...input, threadId: "foreign-thread" })).toThrow();
    }
  });
  it("keeps native state in the physical conversation HOME and pins multi-agent configuration", () => {
    expect(cloudCodexConfig(execution())).toMatchObject({ sqlite_home: path.join(nativeHome.paths.codexHome,"sessions",".zeros-state"), "features.multi_agent": true });
    const result = cloudCodexRequest(execution(), "env", "thread/start", { config: { sqlite_home: "/private", "features.hooks": true, "features.multi_agent": false } }) as { config: Record<string, unknown> };
    expect(result.config.sqlite_home).toBe(path.join(nativeHome.paths.codexHome,"sessions",".zeros-state"));
    expect(result.config["features.multi_agent"]).toBe(true);
    expect(result.config).not.toHaveProperty("features.hooks");
  });
  it("admits only inline review on the selected thread", () => {
    const owner = execution(); bindCloudCodexThread(owner, "thread");
    const params = { threadId: "thread", target: { type: "uncommittedChanges" }, delivery: "inline" };
    expect(cloudCodexRequest(owner, "env", "review/start", params)).toEqual(params);
    expect(() => cloudCodexRequest(owner, "env", "review/start", { ...params, delivery: "detached" })).toThrow();
    expect(() => cloudCodexRequest(owner, "env", "review/start", { ...params, threadId: "foreign" })).toThrow();
  });
  it("binds apps to the admitted ChatGPT account and exposes versioned capabilities", () => {
    const account = execution(true), key = execution();
    expect(cloudCodexCapabilities(account)).toMatchObject({ version: 1, goals: true, nativeReview: true, connectedApps: true, multiAgent: true });
    expect(cloudCodexCapabilities(key).connectedApps).toBe(false);
    for (const method of ["app/list", "app/installed"]) {
      expect(() => cloudCodexRequest(account, "env", method, {})).not.toThrow();
      expect(() => cloudCodexRequest(key, "env", method, {})).toThrow();
      expect(() => cloudCodexRequest(account, "env", method, { accountId: "another-account" })).toThrow();
    }
    expect(cloudCodexConfig(account)["mcp_servers.codex_apps.enabled"]).toBeUndefined();
    expect(cloudCodexConfig(key)["mcp_servers.codex_apps.enabled"]).toBe(false);
  });
  it("retains model admission and unknown RPC rejection", () => {
    expect(() => cloudCodexRequest(execution(), "env", "thread/settings/update", { model: "ungranted" })).toThrow(/model/);
    expect(() => cloudCodexRequest(execution(), "env", "account/login/start", {})).toThrow(/not admitted/);
  });
  it("does not infer feature qualification from a basic provider lease", () => {
    const owner=execution(true);
    Object.assign(owner,{nativeCapabilities:null});
    bindCloudCodexThread(owner,"thread");
    expect(cloudCodexCapabilities(owner)).toMatchObject({goals:false,nativeFork:false,nativeReview:false,connectedApps:false,multiAgent:false});
    expect(()=>cloudCodexRequest(owner,"env","thread/goal/get",{threadId:"thread"})).toThrow(/not admitted/);
  });
});
