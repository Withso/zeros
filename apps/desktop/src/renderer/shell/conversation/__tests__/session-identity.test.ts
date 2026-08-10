import { describe, expect, it } from "vitest";

import { sessionIdentityUpdate } from "../session-identity";

describe("sessionIdentityUpdate", () => {
  it("persists the Zeros runtime id and native Codex thread together", () => {
    expect(
      sessionIdentityUpdate(
        { sessionId: undefined, nativeSessionId: undefined },
        "zeros-runtime-1",
        "codex-thread-1",
      ),
    ).toEqual({
      sessionId: "zeros-runtime-1",
      nativeSessionId: "codex-thread-1",
    });
  });

  it("does not dispatch when the exact identity pair is already persisted", () => {
    expect(
      sessionIdentityUpdate(
        {
          sessionId: "zeros-runtime-1",
          nativeSessionId: "codex-thread-1",
        },
        "zeros-runtime-1",
        "codex-thread-1",
      ),
    ).toBeNull();
  });

  it("keeps legacy providers compatible when no separate native id exists", () => {
    expect(
      sessionIdentityUpdate(
        { sessionId: "old", nativeSessionId: "stale" },
        "claude-session-2",
        null,
      ),
    ).toEqual({
      sessionId: "claude-session-2",
      nativeSessionId: undefined,
    });
  });

  it("does nothing before a live runtime session exists", () => {
    expect(
      sessionIdentityUpdate(
        { sessionId: undefined, nativeSessionId: undefined },
        null,
        "codex-thread-1",
      ),
    ).toBeNull();
  });
});
