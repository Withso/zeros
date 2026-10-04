import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
const fixture=vi.hoisted(()=>({launch:vi.fn(),scope:vi.fn(),retire:vi.fn(async()=>{}),prepare:vi.fn(),attach:vi.fn()}));
vi.mock("node:child_process",async original=>({...await original<typeof import("node:child_process")>(),spawn:fixture.launch}));
vi.mock("../cloud-workspace-validation/sandbox/cloud-engine-cgroup.mjs",async original=>({
  ...await original<typeof import("../cloud-workspace-validation/sandbox/cloud-engine-cgroup.mjs")>(),
  CloudEngineCgroup:class {constructor(options:unknown){fixture.scope(options);}retire=fixture.retire;prepare=fixture.prepare;attach=fixture.attach;},
}));
// @ts-expect-error The image helper is plain Node JavaScript.
import { validateCloudSetupPayload,runScopedCloudSetup } from "../cloud-workspace-validation/sandbox/cloud-setup-process.mjs";
import {createCloudRuntimeResolver} from "../../apps/desktop/src/engine/agents/containment/cloud-runtime-root.mjs";
import {cloudRuntimeFixture} from "../../apps/desktop/src/engine/agents/containment/__tests__/cloud-runtime-fixture";
const valid = () => ({
  version: 1,
  command: "node --version",
  timeoutMs: 30000,
  environment: { PACKAGE_TOKEN: "test-only-package-token" },
});
describe("bounded unprivileged setup process", () => {
  it("pins v4 setup children and waits for descendant drain after the parent exits",async()=>{
    const tree=cloudRuntimeFixture();
    try {
      const runtime=createCloudRuntimeResolver({filesystem:tree.filesystem}).resolve();
      const child=Object.assign(new EventEmitter(),{pid:4242,stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),stdio:[null,null,null,new PassThrough()],kill:vi.fn()});
      fixture.launch.mockReturnValue(child);
      let drained!:()=>void;
      fixture.retire.mockResolvedValueOnce(undefined).mockImplementationOnce(()=>new Promise<void>(resolve=>{drained=resolve;}));
      const pending=runScopedCloudSetup(valid(),{runtime});
      await Promise.resolve();
      expect(fixture.scope).toHaveBeenCalledWith(expect.objectContaining({runtime,kind:"setup"}));
      expect(fixture.launch.mock.calls.at(-1)?.slice(0,2)).toEqual([runtime.node,[runtime.helpers.setupProcess,"--worker"]]);
      expect(fixture.attach).toHaveBeenCalledWith(4242);
      child.emit("exit",0);expect(fixture.retire).toHaveBeenCalledTimes(2);
      let settled=false;void pending.then(()=>{settled=true;});
      child.emit("close",0,null);await Promise.resolve();expect(settled).toBe(false);
      drained();await expect(pending).resolves.toMatchObject({code:0,timedOut:false});
    } finally {tree.dispose();vi.clearAllMocks();}
  });
  it("keeps setup command and secrets as data with a fixed worker identity and directory", () => {
    expect(validateCloudSetupPayload(valid())).toEqual(valid());
    for (const change of [
      { uid: 0 },
      { cwd: "/root" },
      { executable: "/bin/bash" },
      { timeoutMs: 0 },
      { timeoutMs: 3600001 },
      { command: "" },
      { environment: { NODE_OPTIONS: "--require=/tmp/code" } },
      { environment: { PATH: "/tmp" } },
      { environment: { LD_PRELOAD: "/tmp/code" } },
      { environment: { "BASH_FUNC_fn%%": "() {}" } },
      { environment: { TOKEN: "a\0b" } },
    ])
      expect(() =>
        validateCloudSetupPayload({ ...valid(), ...change }),
      ).toThrow(/setup process/);
  });
});
