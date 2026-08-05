// Classification tests for the codex app-server adapter's thread-
// failure path + regex parity guards across the three
// session-expired keyword sets that ride together in production:
//
//   - STALE_THREAD_RX            (this adapter — decides resume→start auto-fallback)
//   - SESSION_EXPIRED_KEYWORDS   (adapters/shared/session-expiry.ts)
//   - SESSION_EXPIRED_RX         (zeros/bridge/failure.ts — renderer-side fallback regex)
//
// All three must match the same fixture strings so:
//   • the engine throws AgentFailureError with kind="session-expired"
//   • the bridge passes it through unchanged
//   • IF the bridge fails to set msg.failure (legacy back-compat),
//     the renderer's regex fallback still produces the same kind
//
// If you add a new wording variant to one of the regexes, add the
// fixture below AND mirror the regex change in the other two files.

import { describe, expect, it } from "vitest";

import { classifyThreadFailure, STALE_THREAD_RX } from "../app-server-adapter";
import { SESSION_EXPIRED_KEYWORDS } from "../../shared/session-expiry";
import { SESSION_EXPIRED_RX } from "../../../../../renderer/platform/bridge/failure";
import { AgentFailureError } from "../../../types";

/** Real codex stderr / RPC error strings observed in the wild +
 *  the user-facing wording the adapter itself produces. */
const STALE_FIXTURES = [
  // Codex's own wording across versions
  "thread/resume failed: no rollout found for thread id ABC-123",
  "thread/resume failed",
  "no rollout found for thread XYZ",
  "rollout not found for thread XYZ",
  "Codex no longer has a rollout for this thread. Start a fresh chat to continue.",
  // Codex's mid-turn reconnect wording — the engine must classify its OWN
  // message as session-expired (the engine regexes previously lacked this
  // clause that the renderer-side SESSION_EXPIRED_RX already had).
  "Codex lost the rollout for this thread mid-turn. Reconnecting…",
  // Generic stale-thread wording observed across runtime versions.
  "thread not found",
  "thread does not exist",
  "unknown thread",
  "missing thread",
  "no such thread",
  "chat does not exist",
  "chat not found",
  "session not found",
  "session does not exist",
  "session expired",
  "resume failed",
  "conversation not found",
  "conversation expired",
  // @cursor/sdk Agent.resume — the persisted agentId is gone from
  // Cursor's local store. Added 2026-05-31 so cursor-sdk classifies it
  // as session-expired instead of a hard "Agent error" toast.
  "Agent 896fa66e-4bcc-4786-9571-f042b857cd06 not found",
  "cursor-sdk loadSession failed: Agent abc-123 not found",
  "Agent not found",
  "no such agent",
  "agent does not exist",
  // Claude stale-resume wording (cross-worktree resume). Added 2026-06-01.
  "No conversation found with session ID 7f3a-…",
  "no conversation found",
];

/** Errors that should NOT classify as session-expired so we don't
 *  silently swallow real protocol/auth issues. */
const NON_STALE_FIXTURES = [
  "ECONNREFUSED 127.0.0.1:8080",
  "JSON-RPC parse error: unexpected token",
  "codex CLI 0.130.0 is too old for the app-server adapter.",
  "permission denied (publickey)",
  "Engine swapping — request aborted", // covered by TRANSPORT_RX in failure.ts
];

describe("STALE_THREAD_RX", () => {
  for (const fixture of STALE_FIXTURES) {
    it(`matches: "${fixture}"`, () => {
      expect(STALE_THREAD_RX.test(fixture)).toBe(true);
    });
  }

  for (const fixture of NON_STALE_FIXTURES) {
    it(`does NOT match: "${fixture}"`, () => {
      expect(STALE_THREAD_RX.test(fixture)).toBe(false);
    });
  }
});

describe("regex parity (engine ↔ bridge)", () => {
  // Every fixture that's session-expired according to the adapter's
  // STALE_THREAD_RX MUST also be classified session-expired on the
  // other two sides; otherwise an engine-classified failure travels
  // across the wire fine but a fallback regex on the renderer
  // mis-classifies as protocol-error → "Agent error" toast.
  for (const fixture of STALE_FIXTURES) {
    it(`base.SESSION_EXPIRED_KEYWORDS matches "${fixture}"`, () => {
      expect(SESSION_EXPIRED_KEYWORDS.test(fixture)).toBe(true);
    });
    it(`bridge.SESSION_EXPIRED_RX matches "${fixture}"`, () => {
      expect(SESSION_EXPIRED_RX.test(fixture)).toBe(true);
    });
  }

  // And the negative direction — anything we explicitly don't want
  // to classify as session-expired stays out of the other two regexes.
  for (const fixture of NON_STALE_FIXTURES) {
    it(`base.SESSION_EXPIRED_KEYWORDS does NOT match "${fixture}"`, () => {
      expect(SESSION_EXPIRED_KEYWORDS.test(fixture)).toBe(false);
    });
    it(`bridge.SESSION_EXPIRED_RX does NOT match "${fixture}"`, () => {
      expect(SESSION_EXPIRED_RX.test(fixture)).toBe(false);
    });
  }
});

// Fixture-based parity (above) only catches drift for the exact wordings
// we happen to list. This source-level guard fails CI the moment any of
// the three regexes is edited without mirroring the other two — even for
// wordings nobody added a fixture for yet.
describe("session-expired regex source parity", () => {
  it("STALE_THREAD_RX, SESSION_EXPIRED_KEYWORDS, SESSION_EXPIRED_RX share source+flags", () => {
    expect(STALE_THREAD_RX.source).toBe(SESSION_EXPIRED_KEYWORDS.source);
    expect(SESSION_EXPIRED_RX.source).toBe(SESSION_EXPIRED_KEYWORDS.source);
    expect(STALE_THREAD_RX.flags).toBe(SESSION_EXPIRED_KEYWORDS.flags);
    expect(SESSION_EXPIRED_RX.flags).toBe(SESSION_EXPIRED_KEYWORDS.flags);
  });
});

describe("classifyThreadFailure", () => {
  it("returns AgentFailureError(session-expired) for stale fixtures on prompt stage", () => {
    for (const fixture of STALE_FIXTURES) {
      const result = classifyThreadFailure(new Error(fixture), "prompt");
      expect(result).toBeInstanceOf(AgentFailureError);
      const failure = (result as AgentFailureError).failure;
      expect(failure.kind).toBe("session-expired");
      expect(failure.stage).toBe("prompt");
      expect(failure.agentId).toBe("codex");
    }
  });

  it("returns AgentFailureError(session-expired) for stale fixtures on loadSession stage", () => {
    for (const fixture of STALE_FIXTURES) {
      const result = classifyThreadFailure(new Error(fixture), "loadSession");
      expect(result).toBeInstanceOf(AgentFailureError);
      const failure = (result as AgentFailureError).failure;
      expect(failure.kind).toBe("session-expired");
      expect(failure.stage).toBe("loadSession");
    }
  });

  it("differentiates the user-facing message by stage", () => {
    const onPrompt = classifyThreadFailure(
      new Error("no rollout found"),
      "prompt",
    );
    const onLoad = classifyThreadFailure(
      new Error("no rollout found"),
      "loadSession",
    );
    expect((onPrompt as AgentFailureError).failure.message).toContain("mid-turn");
    expect((onLoad as AgentFailureError).failure.message).toContain("Start a fresh chat");
  });

  it("returns AgentFailureError(auth-required) on auth-hint errors", () => {
    const result = classifyThreadFailure(
      new Error("Please run /login: not signed in"),
      "prompt",
    );
    expect(result).toBeInstanceOf(AgentFailureError);
    expect((result as AgentFailureError).failure.kind).toBe("auth-required");
  });

  it("returns the raw error untouched when no pattern matches", () => {
    const original = new Error("ECONNREFUSED 127.0.0.1:8080");
    const result = classifyThreadFailure(original, "prompt");
    expect(result).not.toBeInstanceOf(AgentFailureError);
    expect(result.message).toBe("ECONNREFUSED 127.0.0.1:8080");
  });
});
