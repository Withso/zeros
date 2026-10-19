import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runCloudRunnerTransport, runnerTransportArguments } from "../cloud-runner-transport.mjs";
const id = "11111111-1111-4111-8111-111111111111", runtime = `r1-${"a".repeat(64)}`;
const args = ["/tmp/zeros-runners-abcdef", "123", "100", "1", "2", "120", "90", id, runtime, id, "1", "3"];
const intent = { version: 1, attemptId: id, scope: { version: 1, owner: { pid: 120, startToken: "90" },
  bootId: id, runtimeId: runtime, executionId: id,
  workload: { directory: "/sys/fs/cgroup/system.slice/zeros-host.service/engine-runtime/engine-workload-shared/workload", dev: "1", ino: "3" } } };
describe("credential-free runner transport", () => {
  it("submits the original start once with inherited descriptors after a bounded prelude", async () => {
    const input = new PassThrough(), child = new EventEmitter(), spawn = vi.fn(() => child);
    const running = runCloudRunnerTransport({ input, args, spawnProcess: spawn });
    expect(spawn).not.toHaveBeenCalled();
    input.write(JSON.stringify({ type: "start", intent }) + "\n");
    await expect.poll(() => spawn.mock.calls.length).toBe(1);
    expect(spawn).toHaveBeenCalledWith(`/opt/zeros-infra/${runtime}/bin/cloud-runner-bus`,
      ["start", ...args.slice(0, 10), id, ...args.slice(10)], { cwd: "/", env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, stdio: "inherit" });
    child.emit("close", 7, null); expect(await running).toBe(7);
    input.end();
  });
  it.each(["owner", "boot", "execution", "trailing", "oversize"])("refuses a %s prelude without a native submission", async kind => {
    const input = new PassThrough(), spawn = vi.fn();
    const running = runCloudRunnerTransport({ input, args, spawnProcess: spawn });
    const rejected = expect(running).rejects.toThrow("cloud_runner_transport_unavailable");
    const changed = structuredClone(intent);
    if (kind === "owner") changed.scope.owner.pid++;
    if (kind === "boot") changed.scope.bootId = "22222222-2222-4222-8222-222222222222";
    if (kind === "execution") changed.scope.executionId = "22222222-2222-4222-8222-222222222222";
    input.write(kind === "oversize" ? "x".repeat(4097) : JSON.stringify({ type: "start", intent: changed }) + "\n" + (kind === "trailing" ? "private" : ""));
    await rejected; expect(spawn).not.toHaveBeenCalled(); input.destroy();
  });
  it("never accepts an alternate bus directory or executable", () => {
    expect(() => runnerTransportArguments(["/run/user/10003", ...args.slice(1)])).toThrow();
    expect(() => runnerTransportArguments(args.map((value, index) => index === 8 ? "../foreign" : value))).toThrow();
  });
});
