import { describe, expect, it } from "vitest";

import { sessionsEligibleForRevocation } from "./workos-command-outbox.js";

describe("WorkOS account lifecycle commands", () => {
  it("never revokes a recovery session created after the deletion cutoff", () => {
    expect(
      sessionsEligibleForRevocation(
        [
          {
            id: "session_old",
            status: "active",
            createdAt: "2026-09-01T00:00:00.000Z",
          },
          {
            id: "session_recovery",
            status: "active",
            createdAt: "2026-09-01T00:00:02.000Z",
          },
          {
            id: "session_ended",
            status: "ended",
            createdAt: "2026-08-31T23:59:00.000Z",
          },
        ],
        "2026-09-01T00:00:01.000Z",
      ),
    ).toEqual(["session_old"]);
  });

  it("fails closed on malformed provider timestamps", () => {
    expect(
      sessionsEligibleForRevocation(
        [{ id: "session_unknown", status: "active", createdAt: "invalid" }],
        "2026-09-01T00:00:01.000Z",
      ),
    ).toEqual([]);
  });
});
