import { describe, expect, it, vi } from "vitest";
import { assertPrivatePidNamespace, retirePrivateProcesses } from "../cloud-workspace-validation/cloud-agent-e2e/fixture-scope";

describe("SOURCE-MODE CPU/private-PID fixture scope", () => {
  it("refuses process enumeration or kill outside the new private PID namespace init", () => {
    expect(() => assertPrivatePidNamespace("pid:[1]", "pid:[1]", 1)).toThrow("private_pid_namespace_required");
    expect(() => assertPrivatePidNamespace("pid:[1]", "pid:[2]", 20)).toThrow("private_pid_namespace_required");
    expect(() => assertPrivatePidNamespace("pid:[1]", "pid:[2]", 1)).not.toThrow();
  });
  it("kills every private descendant while preserving namespace init, including escaped process groups", async () => {
    const kill = vi.fn(); let reads = 0;
    await retirePrivateProcesses({ members: () => ++reads === 1 ? [1, 2, 38] : [], kill, pause: async () => {}, now: () => 0 });
    expect(kill.mock.calls).toEqual([[2], [38]]);
  });
  it("refuses retirement when a descendant remains alive", async () => {
    let now = 0;
    await expect(retirePrivateProcesses({ members: () => [1, 2], kill: () => {}, pause: async () => { now += 10; }, now: () => now }, 15))
      .rejects.toThrow("cleanup_unconfirmed");
  });
});
