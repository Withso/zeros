import { describe, expect, it } from "vitest";
import { codexAnyModeAllowed, codexModeAllowed, codexPolicyBlockedMessage, resolveCodexMode } from "../agent-modes";

describe("Codex managed mode resolution", () => {
  it("keeps every mode when no allow-list is configured", () => {
    for (const mode of ["ask", "auto-edit", "full-access", "read-only"] as const) {
      expect(resolveCodexMode(mode, null)).toBe(mode);
      expect(resolveCodexMode(mode, { allowedApprovalPolicies: null, allowedSandboxModes: null })).toBe(mode);
    }
  });

  it("falls back only to the nearest more restrictive allowed mode", () => {
    const noDanger = { allowedApprovalPolicies: null, allowedSandboxModes: ["read-only", "workspace-write"] };
    expect(resolveCodexMode("full-access", noDanger)).toBe("auto-edit");
    const onRequestOnly = { allowedApprovalPolicies: ["on-request"], allowedSandboxModes: null };
    expect(resolveCodexMode("ask", onRequestOnly)).toBe("read-only");
  });

  it("never silently grants a less restrictive mode, such as Plan becoming Full access", () => {
    const neverOnly = { allowedApprovalPolicies: ["never"], allowedSandboxModes: null };
    expect(resolveCodexMode("ask", neverOnly)).toBeNull();
    expect(resolveCodexMode("read-only", neverOnly)).toBeNull();
    expect(resolveCodexMode("read-only", neverOnly, ["read-only", "full-access"])).toBeNull();
    expect(codexAnyModeAllowed(neverOnly)).toBe(true);
    expect(codexPolicyBlockedMessage(neverOnly, "read-only")).toContain('does not allow the "read-only" permission mode');
  });

  it("limits fallback to the offered modes and reports none when nothing is allowed", () => {
    const requirements = { allowedApprovalPolicies: ["untrusted", "on-request"], allowedSandboxModes: ["read-only", "workspace-write"] };
    expect(resolveCodexMode("full-access", requirements, ["read-only", "full-access"])).toBe("read-only");
    expect(resolveCodexMode("ask", { allowedApprovalPolicies: [], allowedSandboxModes: null })).toBeNull();
  });

  it("ignores granular approval entries Zeros never sends", () => {
    const requirements = { allowedApprovalPolicies: [{ granular: {} }], allowedSandboxModes: null };
    expect(codexModeAllowed("auto-edit", requirements)).toBe(false);
    expect(codexPolicyBlockedMessage(requirements)).toBe(
      "Your organization's Codex policy allows none of Zeros' permission modes. Allowed approval policies: granular; allowed sandbox modes: any. Ask your administrator to allow one.",
    );
  });
});
