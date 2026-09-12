import { describe, expect, it } from "vitest";

import {
  deletionGracePeriod,
  deletionLifecycleErrorCode,
  deletionRecoveryCode,
  isDeletionRecoveryRequest,
  requiresFreshAuthentication,
} from "./deletion-lifecycle.js";

describe("deletion lifecycle policy", () => {
  it("uses one recoverable 30-day grace period for accounts and organizations", () => {
    const requestedAt = new Date("2026-09-01T00:00:00.000Z");
    expect(deletionGracePeriod(requestedAt).toISOString()).toBe(
      "2026-10-01T00:00:00.000Z",
    );
  });

  it("requires a WorkOS ceremony no older than five minutes", () => {
    const nowSeconds = Date.parse("2026-09-01T00:05:00.000Z") / 1_000;
    expect(requiresFreshAuthentication(nowSeconds - 300, nowSeconds)).toBe(
      false,
    );
    expect(requiresFreshAuthentication(nowSeconds - 301, nowSeconds)).toBe(
      true,
    );
    expect(requiresFreshAuthentication(null, nowSeconds)).toBe(true);
    expect(requiresFreshAuthentication(nowSeconds + 61, nowSeconds)).toBe(
      true,
    );
  });

  it("generates a human-readable locator that is never authentication", () => {
    expect(deletionRecoveryCode()).toMatch(/^ZD-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });

  it("allows deletion-pending authentication only for exact recovery routes", () => {
    expect(isDeletionRecoveryRequest("GET", "/v1/account/deletion")).toBe(
      true,
    );
    expect(
      isDeletionRecoveryRequest("POST", "/v1/account/deletion/restore"),
    ).toBe(true);
    expect(isDeletionRecoveryRequest("DELETE", "/v1/account/deletion")).toBe(
      false,
    );
    expect(isDeletionRecoveryRequest("GET", "/v1/me")).toBe(false);
    expect(
      isDeletionRecoveryRequest("GET", "/v1/account/deletion/restore/extra"),
    ).toBe(false);
  });

  it("retains a bounded operational reason without persisting raw error text", () => {
    expect(
      deletionLifecycleErrorCode(
        new Error("organization_cloud_deletion_not_verified"),
      ),
    ).toBe("organization_cloud_deletion_not_verified");
    expect(deletionLifecycleErrorCode(new Error("unsafe reason: /tmp/a"))).toBe(
      "unsafe_reason___tmp_a",
    );
  });
});
