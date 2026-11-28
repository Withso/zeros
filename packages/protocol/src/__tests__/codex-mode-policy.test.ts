import { describe, expect, it } from "vitest";
import { codexModeAllowed, codexPolicyBlockedMessage, resolveCodexMode } from "../agent-modes";

describe("Codex managed mode resolution", () => {
  it("keeps every mode when no allow-list is configured", () => {
    for (const mode of ["ask", "auto-edit", "full-access", "read-only"] as const) {
      expect(resolveCodexMode(mode, null)).toBe(mode);
      expect(resolveCodexMode(mode, { allowedApprovalPolicies: null, allowedSandboxModes: null })).toBe(mode);
    }
  });

  it("prefers the nearest more restrictive allowed mode, then a less restrictive one", () => {
    const noDanger = { allowedApprovalPolicies: null, allowedSandboxModes: ["read-only", "workspace-write"] };
    expect(resolveCodexMode("full-access", noDanger)).toBe("auto-edit");
    const onRequestOnly = { allowedApprovalPolicies: ["on-request"], allowedSandboxModes: null };
    expect(resolveCodexMode("ask", onRequestOnly)).toBe("read-only");
    const neverOnly = { allowedApprovalPolicies: ["never"], allowedSandboxModes: null };
    expect(resolveCodexMode("ask", neverOnly)).toBe("full-access");
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
