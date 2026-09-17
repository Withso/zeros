import { describe, expect, it } from "vitest";
import type { RequestPermissionRequest } from "../../../platform/bridge/agent-events";
import { permissionPolicyOption, type PolicyRule } from "../policies";

const rule: PolicyRule = {
  id: "saved",
  chatId: "chat",
  toolTitle: "Bash",
  decision: "allow",
  createdAt: 1,
};
const request: RequestPermissionRequest = {
  sessionId: "session",
  toolCall: { toolCallId: "tool", title: "Bash", kind: "execute" },
  options: [
    { optionId: "once", kind: "allow_once", name: "Yes" },
    { optionId: "chat", kind: "allow_always", name: "Allow for this chat" },
    { optionId: "deny", kind: "reject_once", name: "No" },
  ],
};

describe("permission policy eligibility", () => {
  it("keeps ordinary saved approvals and once-only fallback working", () => {
    expect(permissionPolicyOption([rule], request)?.optionId).toBe("chat");
    expect(
      permissionPolicyOption([rule], {
        ...request,
        options: request.options.filter((o) => o.kind !== "allow_always"),
      })?.optionId,
    ).toBe("once");
  });
  it("never bypasses an explicit Yes/No request, even with stale broad options", () => {
    expect(
      permissionPolicyOption([rule], {
        ...request,
        requiresExplicitApproval: true,
      }),
    ).toBeNull();
    expect(
      permissionPolicyOption([{ ...rule, decision: "reject" }], {
        ...request,
        requiresExplicitApproval: true,
      }),
    ).toBeNull();
  });
  it("retains native provider policy isolation", () => {
    expect(
      permissionPolicyOption([rule], { ...request, allowLocalPolicies: false }),
    ).toBeNull();
  });
  it("does not match a saved rule for a different tool", () => {
    expect(
      permissionPolicyOption([{ ...rule, toolTitle: "Read" }], request),
    ).toBeNull();
  });
  it("keeps ordinary saved denials scoped to an offered option", () => {
    expect(
      permissionPolicyOption([{ ...rule, decision: "reject" }], request)
        ?.optionId,
    ).toBe("deny");
    expect(
      permissionPolicyOption([{ ...rule, decision: "reject" }], {
        ...request,
        options: [],
      }),
    ).toBeNull();
  });
});
