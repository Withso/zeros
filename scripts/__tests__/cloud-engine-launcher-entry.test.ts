import { describe, expect, it, vi } from "vitest";
import { launchCloudEngineEntry } from "../cloud-workspace-validation/sandbox/cloud-engine-launcher.mjs";

const runtime = { profile: "v4", cgroupRoot: "/sys/fs/cgroup/system.slice/zeros-host.service" };

describe("cloud engine launcher entries", () => {
  it("enters the original host before qualifying through the attester's fixed entry", async () => {
    const order: string[] = [];
    const launch = vi.fn(async (options: { operation: string }) => { order.push(`launch:${options.operation}`); return 0; });
    const enterHost = vi.fn(() => { order.push("enter"); });
    await expect(launchCloudEngineEntry(["--host-qualify"], { launch, enterHost, resolveRuntime: () => runtime })).resolves.toBe(0);
    expect(order).toEqual(["enter", "launch:qualify"]);
    expect(enterHost).toHaveBeenCalledWith(runtime);
    expect(launch).toHaveBeenCalledWith({ runtime, operation: "qualify" });
  });

  it("never launches when the original host refuses the entry", async () => {
    const launch = vi.fn();
    const enterHost = vi.fn(() => { throw new Error("Cloud root host entry was refused"); });
    await expect(launchCloudEngineEntry(["--host-qualify"], { launch, enterHost, resolveRuntime: () => runtime }))
      .rejects.toThrow("Cloud root host entry was refused");
    expect(launch).not.toHaveBeenCalled();
  });

  it.each([[[], "serve"], [["--qualify"], "qualify"], [["--resident"], "resident"], [["--probe-cursor"], "probe-cursor"]] as const)(
    "keeps %j an unplaced %s launch behind the launcher's own placement gate", async (args, operation) => {
      const launch = vi.fn(async () => 0), enterHost = vi.fn();
      await launchCloudEngineEntry([...args], { launch, enterHost, resolveRuntime: () => runtime });
      expect(launch).toHaveBeenCalledWith({ operation });
      expect(enterHost).not.toHaveBeenCalled();
    });

  it.each([[["--host-qualify", "--qualify"]], [["--unknown"]], [["--qualify", "--qualify"]]])("refuses the entry %j", args => {
    const launch = vi.fn(), enterHost = vi.fn();
    expect(launchCloudEngineEntry(args, { launch, enterHost, resolveRuntime: () => runtime })).toBeNull();
    expect(launch).not.toHaveBeenCalled();
    expect(enterHost).not.toHaveBeenCalled();
  });
});
