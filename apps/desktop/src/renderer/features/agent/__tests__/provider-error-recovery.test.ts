import { describe, expect, it } from "vitest";
import { isRecoverable } from "../../../platform/bridge/failure";
import {
  promptFailureShouldRecover,
  resumeFailureInvalidatesBinding,
  statusForFailure,
} from "../session-reload-lifecycle";

describe("account verification and cloud credential recovery", () => {
  it.each(["verification-required", "cloud-credentials-unavailable"] as const)(
    "keeps %s terminal until user action, preserving the conversation",
    (kind) => {
      const failure = { kind, message: "Provider explanation", stage: "prompt" as const };
      expect(statusForFailure(failure)).toBe("failed");
      expect(isRecoverable(failure)).toBe(false);
      expect(promptFailureShouldRecover(failure)).toBe(false);
      expect(resumeFailureInvalidatesBinding(failure)).toBe(false);
    },
  );
});
