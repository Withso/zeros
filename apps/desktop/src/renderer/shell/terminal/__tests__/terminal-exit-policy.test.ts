import { describe, expect, it } from "vitest";
import { terminalExitPolicy } from "../terminal-exit-policy";

describe("terminalExitPolicy", () => {
  it("keeps ordinary shell exits restartable", () => {
    expect(terminalExitPolicy()).toEqual({ restartBlocked: false });
  });

  it("keeps a transient host loss restartable", () => {
    expect(terminalExitPolicy("host-lost")).toEqual({
      restartBlocked: false,
    });
  });

  it.each(["spawn-failed", "host-unavailable"] as const)(
    "blocks deterministic infrastructure failure %s",
    (reason) => {
      const policy = terminalExitPolicy(reason);
      expect(policy.restartBlocked).toBe(true);
      if (!policy.restartBlocked) throw new Error("expected blocked policy");
      expect(policy.detail).toBeTruthy();
      expect(policy.recovery).toBeTruthy();
    },
  );
});
