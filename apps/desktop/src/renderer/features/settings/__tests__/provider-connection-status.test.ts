import { describe, expect, it } from "vitest";

import { providerConnectionStatus } from "../provider-connection-status";

describe("providerConnectionStatus", () => {
  it("distinguishes an unavailable auth probe from a confirmed signed-out CLI", () => {
    expect(
      providerConnectionStatus({
        installed: true,
        authenticationUnavailableReason:
          "Zeros Sandbox Runtime could not verify this CLI's sign-in state.",
      }),
    ).toEqual({
      label: "Authentication check unavailable",
      tone: "warning",
      detail:
        "Zeros Sandbox Runtime could not verify this CLI's sign-in state.",
    });
  });

  it("retains confirmed connected, signed-out, missing-runtime, and missing-CLI states", () => {
    expect(providerConnectionStatus({ authenticated: true })).toMatchObject({
      label: "Connected",
      tone: "success",
    });
    expect(
      providerConnectionStatus({ installed: true, authenticated: false }),
    ).toMatchObject({ label: "CLI not authenticated", tone: "error" });
    expect(
      providerConnectionStatus({
        installed: false,
        runtimeUnavailableReason: "runtime unavailable",
      }),
    ).toEqual({
      label: "Runtime missing",
      tone: "error",
      detail: "runtime unavailable",
    });
    expect(providerConnectionStatus({ installed: false })).toMatchObject({
      label: "CLI not found",
      tone: "error",
    });
  });
});
