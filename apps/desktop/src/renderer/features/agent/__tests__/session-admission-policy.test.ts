import { describe, expect, it } from "vitest";

import {
  AGENT_NEW_SESSION_TIMEOUT_MS,
  shouldRetrySessionAdmission,
} from "../session-admission-policy";
import * as admissionPolicy from "../session-admission-policy";

describe("agent session admission policy", () => {
  it("allows bounded provider startup and boundary cleanup to finish", () => {
    expect(AGENT_NEW_SESSION_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000);
  });

  it("never automatically overlaps an admission that timed out", () => {
    expect(shouldRetrySessionAdmission("timeout")).toBe(false);
    expect(shouldRetrySessionAdmission("transport-closed")).toBe(true);
    expect(shouldRetrySessionAdmission("protocol-error")).toBe(false);
  });

  it("cancels the engine-side conversation bind after an admission timeout", () => {
    const shouldCancel = (
      admissionPolicy as unknown as {
        shouldCancelStalledSessionAdmission?: (
          kind: "timeout" | "transport-closed",
        ) => boolean;
      }
    ).shouldCancelStalledSessionAdmission;

    expect(shouldCancel?.("timeout")).toBe(true);
    expect(shouldCancel?.("transport-closed")).toBe(false);
  });
});
