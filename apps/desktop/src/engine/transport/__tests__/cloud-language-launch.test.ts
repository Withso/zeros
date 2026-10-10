import {describe,it,expect,vi} from "vitest";
import {cloudLanguageLaunch} from "../cloud-language-services";
import type {CloudWorkerConfiguration} from "../../agents/containment/cloud-worker-config";
import {testCloudRuntime,testCloudWorker} from "../../agents/__tests__/helpers/test-cloud-runtime";
vi.mock("../../agents/containment/cloud-runtime-root.mjs",async original=>({
  ...await original<typeof import("../../agents/containment/cloud-runtime-root.mjs")>(),
  resolveCloudRuntime:(await import("../../agents/__tests__/helpers/test-cloud-runtime")).testCloudRuntime,
}));
const worker:CloudWorkerConfiguration=testCloudWorker();
const args=["--max-old-space-size=256",`${testCloudRuntime().workerRoot}/node_modules/pyright/langserver.index.js`,"--stdio"];
describe("human language server launch boundary",()=>{
  it("inherits the engine identity and normal VM network with exact pinned server arguments",()=>{
    expect(cloudLanguageLaunch(worker,worker.toolchain.node,args)).toEqual({
      command:worker.toolchain.node,script:args[1],args,
    });
  });
  it("rejects caller binaries, argument injection and relative paths",()=>{
    for(const command of ["node","/bin/bash","/srv/zeros/workspace/node"])expect(()=>cloudLanguageLaunch(worker,command,args)).toThrow();
    for(const extra of [[...args,"--inspect=0.0.0.0"],["-e","process.exit(0)"],["/srv/zeros/workspace/server.js"]])
      expect(()=>cloudLanguageLaunch(worker,worker.toolchain.node,extra)).toThrow();
  });
  it("does not execute historical privilege-drop and namespace helper paths",()=>{
    const launched=cloudLanguageLaunch({...worker,toolchain:{...worker.toolchain,bwrap:'obsolete',setpriv:'obsolete'}},worker.toolchain.node,args);
    expect(launched.command).toBe(worker.toolchain.node);
    expect(launched.args).toEqual(args);
  });
});
