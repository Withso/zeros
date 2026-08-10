import { describe, expect, it } from "vitest";

import { classifyRpcError, isRecoverable } from "../failure";

describe("agent failure classification", () => {
  it("preserves serialized provider throttling as rate-limited", () => {
    const failure = classifyRpcError({
      agentId: "cursor",
      stage: "prompt",
      error: new Error("429 resource exhausted: rate limit reached"),
    });

    expect(failure).toMatchObject({
      kind: "rate-limited",
      agentId: "cursor",
      stage: "prompt",
    });
    expect(failure.advice).toMatch(/try again/i);
    // Do not amplify a provider throttle with the automatic transport replay.
    expect(isRecoverable(failure)).toBe(false);
  });

  it("does not let retry/timeout wording downgrade a 429 into auto-recovery", () => {
    const failure = classifyRpcError(
      new Error("429 rate limit: connection timed out while waiting to retry"),
      "prompt",
    );

    expect(failure.kind).toBe("rate-limited");
    expect(isRecoverable(failure)).toBe(false);
  });

  it("classifies a deduplicated bind request as superseded, not expired", () => {
    const failure = classifyRpcError({
      agentId: "codex",
      stage: "loadSession",
      error: new Error(
        "AGENT_LOAD_SESSION superseded by newer queued copy",
      ),
    });

    expect(failure).toMatchObject({
      kind: "lifecycle-superseded",
      stage: "loadSession",
    });
    expect(isRecoverable(failure)).toBe(false);
  });
});
