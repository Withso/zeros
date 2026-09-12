import { describe, expect, it } from "vitest";

import type { AuthedUser } from "./auth.js";
import { HttpError } from "./authz.js";
import { maskEmail, requireFreshOpsUser } from "./ops.js";

function operator(
  role: AuthedUser["staffRole"],
  authTime: number | null = Math.floor(Date.now() / 1_000),
): AuthedUser {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    email: "owner@example.test",
    displayName: "Owner",
    avatarUrl: null,
    staffRole: role,
    accountStatus: "active",
    identity: {
      id: "00000000-0000-4000-8000-000000000002",
      provider: "workos",
      subject: "user_01TEST",
    },
    authentication: {
      sessionId: "session_01TEST",
      clientKind: "web",
      authTime,
      tokenExpiresAt: Math.floor(Date.now() / 1_000) + 3_600,
    },
  };
}

describe("Ops authorization boundary", () => {
  it("admits only freshly reauthenticated owners and developers", () => {
    expect(() => requireFreshOpsUser(operator("platform_owner"))).not.toThrow();
    expect(() => requireFreshOpsUser(operator("developer"))).not.toThrow();
    for (const role of ["support_admin", null] as const) {
      expect(() => requireFreshOpsUser(operator(role))).toThrow(HttpError);
    }
  });

  it("rejects refresh-only or stale authentication ceremonies", () => {
    expect(() => requireFreshOpsUser(operator("platform_owner", null))).toThrow(
      HttpError,
    );
    expect(() =>
      requireFreshOpsUser(
        operator("developer", Math.floor(Date.now() / 1_000) - 301),
      ),
    ).toThrow(HttpError);
  });

  it("masks the account local-part and never echoes malformed input", () => {
    expect(maskEmail("account-owner@example.test")).toBe(
      "a******@example.test",
    );
    expect(maskEmail("x@example.com")).toBe("x***@example.com");
    expect(maskEmail("not-an-email")).toBe("***");
  });
});
