import { describe, expect, it, vi } from "vitest";

import { deliverInvitationEmail } from "./invitation-delivery.js";

const email = {
  token: "test-token",
  from: { address: "hello@zeros.build", name: "Zeros" },
};

describe("invitation email ownership", () => {
  it("delivers the Zeros capability email when WorkOS synchronization is enabled", async () => {
    const send = vi.fn(async () => undefined);

    const result = await deliverInvitationEmail(
      {
        email,
        workosEnabled: true,
        destination: "invitee@example.com",
        organizationName: "Analytical Engines",
        inviterName: "Ada",
        acceptUrl: "https://app-alpha.zeros.build/invite?token=opaque",
      },
      send,
    );

    expect(result).toBe("attempted");
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(
      email,
      "invitee@example.com",
      "Ada invited you to Analytical Engines on Zeros",
      expect.stringContaining(
        "https://app-alpha.zeros.build/invite?token=opaque",
      ),
    );
  });

  it("does not attempt delivery when the mailer is unconfigured", async () => {
    const send = vi.fn(async () => undefined);

    const result = await deliverInvitationEmail(
      {
        email: undefined,
        workosEnabled: true,
        destination: "invitee@example.com",
        organizationName: "Analytical Engines",
        inviterName: "Ada",
        acceptUrl: "https://app-alpha.zeros.build/invite?token=opaque",
      },
      send,
    );

    expect(result).toBe("unconfigured");
    expect(send).not.toHaveBeenCalled();
  });
});
