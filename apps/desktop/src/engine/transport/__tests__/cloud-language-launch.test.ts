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
  it("pins a read-only filesystem, private PID/network namespace, cleared groups and workload identity",()=>{
    const launched=cloudLanguageLaunch(worker,worker.toolchain.node,args);
    expect(launched.args).toContain("--unshare-pid");expect(launched.args).toContain("--unshare-net");
    expect(launched.args).toContain("--ro-bind");expect(launched.args).not.toContain("--bind");
    expect(launched.args).toContain("--reuid=10001");expect(launched.args).toContain("--regid=10001");
    expect(launched.args).toContain("--clear-groups");expect(launched.args).toContain("--no-new-privs");
    expect(launched.args.slice(launched.args.indexOf("--size"),launched.args.indexOf("--size")+6)).toEqual(["--size","67108864","--perms","1777","--tmpfs","/tmp"]);
    expect(launched.args.slice(-4)).toEqual([worker.toolchain.node,...args]);
  });
  it("rejects caller binaries, argument injection, relative paths and wrong identity",()=>{
    for(const command of ["node","/bin/bash","/srv/zeros/workspace/node"])expect(()=>cloudLanguageLaunch(worker,command,args)).toThrow();
    for(const extra of [[...args,"--inspect=0.0.0.0"],["-e","process.exit(0)"],["/srv/zeros/workspace/server.js"]])
      expect(()=>cloudLanguageLaunch(worker,worker.toolchain.node,extra)).toThrow();
    expect(()=>cloudLanguageLaunch({...worker,uid:0},worker.toolchain.node,args)).toThrow();
    expect(()=>cloudLanguageLaunch({...worker,toolchain:{...worker.toolchain,bwrap:"bwrap"}},worker.toolchain.node,args)).toThrow();
  });
  it("creates network isolation as the workload user without adding engine network capabilities",()=>{
    const launched=cloudLanguageLaunch(worker,worker.toolchain.node,args);
    expect(launched).toMatchObject({command:worker.toolchain.setpriv});
    expect(launched.args.slice(0,7)).toEqual(["--reuid=10001","--regid=10001","--clear-groups","--no-new-privs","--",worker.toolchain.bwrap,"--unshare-user"]);
    expect(launched.args).not.toContain("--cap-add");
  });
});
