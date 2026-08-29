import { afterEach, describe, expect, it, vi } from "vitest";

import {
  WorkOSDesktopAccountError,
  resolveWorkOSDesktopAccountId,
} from "../workos-desktop-account";

const priorControlPlaneUrl = process.env.ZEROS_CONTROL_PLANE_URL;

afterEach(() => {
  vi.unstubAllGlobals();
  if (priorControlPlaneUrl === undefined) {
    delete process.env.ZEROS_CONTROL_PLANE_URL;
  } else {
    process.env.ZEROS_CONTROL_PLANE_URL = priorControlPlaneUrl;
  }
});

describe("WorkOS desktop account resolution", () => {
  it("preserves only a bounded public recovery locator from the control plane", async () => {
    process.env.ZEROS_CONTROL_PLANE_URL = "https://api-alpha.zeros.build";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: {
              code: "account_recovery_required",
              message: "operator-only wording must not be trusted by the UI",
              details: {
                recoveryCode: "ZR-ABCD-2345",
                expiresInSeconds: 86_400,
                unexpected: "discard me",
              },
            },
          },
          { status: 409 },
        ),
      ),
    );

    await expect(resolveWorkOSDesktopAccountId("access-token")).rejects.toEqual(
      expect.objectContaining<Partial<WorkOSDesktopAccountError>>({
        status: 409,
        code: "account_recovery_required",
        recoveryCode: "ZR-ABCD-2345",
      }),
    );
  });

  it("drops a malformed recovery locator", async () => {
    process.env.ZEROS_CONTROL_PLANE_URL = "https://api-alpha.zeros.build";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: {
              code: "account_recovery_required",
              details: { recoveryCode: "<script>alert(1)</script>" },
            },
          },
          { status: 409 },
        ),
      ),
    );

    await expect(resolveWorkOSDesktopAccountId("access-token")).rejects.toEqual(
      expect.objectContaining<Partial<WorkOSDesktopAccountError>>({
        code: "account_recovery_required",
        recoveryCode: null,
      }),
    );
  });
});
