// PII-contract test for the renderer's analytics EMIT sites (agent-events.ts).
//
// The PostHog contract is "metadata-only / anonymous". core's scrub.test.ts proves
// the scrub PRIMITIVE works in isolation, but nothing proves the renderer actually
// CALLS it / stays clean at every emit site. This locks that: it mocks ./posthog,
// drives every builder (with adversarial inputs — a raw error carrying a path +
// email), and asserts every emitted prop is scalar metadata, never user content.
// A future edit that forwards a raw error.message, file path, or chat snippet to a
// PostHog property fails here — a privacy incident caught at PR time.

import { describe, it, expect, beforeEach, vi } from "vitest";

// vi.hoisted so the spies exist before the (hoisted) vi.mock factory runs.
const { capture, captureException, logEvent } = vi.hoisted(() => ({
  capture: vi.fn(),
  captureException: vi.fn(),
  logEvent: vi.fn(),
}));
vi.mock("../posthog", () => ({ capture, captureException }));
vi.mock("../../logging/renderer-log", () => ({ logEvent }));

import {
  trackAgentSessionStarted,
  trackAgentTurnStarted,
  trackAgentFirstResponse,
  trackAgentPromptCompleted,
  trackAgentSessionEnded,
  trackWorkspaceOpened,
  trackGitOp,
  trackAgentFailed,
  trackAiGeneration,
  trackAgentPromptStarted,
  trackAgentPromptFinished,
  adoptAgentPromptCorrelation,
  peekAgentPromptId,
  trackAgentPermissionDecided,
  trackAgentQuestionAnswered,
} from "../agent-events";

beforeEach(() => {
  capture.mockClear();
  captureException.mockClear();
  logEvent.mockClear();
});

// A prop value is "PII-shaped" if it's a string resembling a path, email, or free
// text — the things that must never reach analytics. Enums, model names, agent
// ids, numbers, booleans are fine.
function piiShaped(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return (
    value.includes("/") || // path
    value.includes("\\") ||
    value.includes("@") || // email
    value.includes("\n") || // multiline / error text
    value.length > 80 // free text
  );
}

function assertCleanProps(props: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(props)) {
    expect(
      ["string", "number", "boolean", "undefined"],
      `prop ${k} type`,
    ).toContain(typeof v);
    expect(piiShaped(v), `prop ${k}=${JSON.stringify(v)} looks like PII`).toBe(
      false,
    );
  }
}

describe("agent-events PII contract — emits scalar metadata only", () => {
  it("every builder's emitted props are scalar metadata (no paths/emails/free text)", () => {
    trackAgentSessionStarted("claude", "chat_1");
    trackAgentTurnStarted("codex", "chat_1");
    trackAgentFirstResponse("chat_1", "message");
    trackAgentPromptCompleted({
      agentId: "claude",
      chatId: "chat_1",
      stopReason: "end_turn",
      durationMs: 1200,
      model: "claude-opus-4-8",
      inputTokens: 10,
      outputTokens: 20,
      costUsd: 0.01,
    });
    trackAgentSessionEnded({
      agentId: "claude",
      chatId: "chat_1",
      outcome: "completed",
    });
    trackWorkspaceOpened({ isWorktree: true, status: "active" });
    trackAiGeneration({
      agentId: "claude",
      model: "claude-opus-4-8",
      traceId: "trace_1",
      latencyMs: 900,
      inputTokens: 5,
      outputTokens: 7,
      costUsd: 0.02,
    });
    trackAgentPromptStarted({
      promptId: "prompt_1",
      chatId: "chat_1",
      agentId: "claude",
      requestedModel: "claude-opus-4-8",
      effort: "high",
      permissionMode: "auto",
      nativeMode: "auto",
      fastEnabled: true,
      contentBlockCount: 2,
      imageAttachmentCount: 1,
      textAttachmentCount: 1,
      mentionFileCount: 1,
      mentionFolderCount: 0,
      mentionSelectionCount: 0,
      additionalDirectoryCount: 1,
      isAutoAction: false,
    });
    trackAgentPermissionDecided({
      chatId: "chat_1",
      agentId: "claude",
      decision: "allow_once",
      toolKind: "execute",
    });
    trackAgentQuestionAnswered({
      chatId: "chat_1",
      agentId: "claude",
      outcome: "answered",
      source: "native_dialog",
      questionCount: 2,
      blocking: true,
    });
    trackAgentPromptFinished({
      promptId: "prompt_1",
      chatId: "chat_1",
      agentId: "claude",
      outcome: "completed",
      durationMs: 900,
      retryCount: 0,
      effectiveModel: "claude-opus-4-8",
    });

    expect(capture.mock.calls.length).toBeGreaterThan(0);
    for (const [event, props] of capture.mock.calls) {
      expect(typeof event).toBe("string");
      if (props) assertCleanProps(props as Record<string, unknown>);
    }
    expect(logEvent.mock.calls.length).toBeGreaterThan(0);
    for (const [, props] of logEvent.mock.calls) {
      if (props) assertCleanProps(props as Record<string, unknown>);
    }
  });

  it("restores prompt correlation after adoption and finishes exactly once", () => {
    adoptAgentPromptCorrelation({
      chatId: "chat_adopt",
      promptId: "prompt-adopt-1",
    });
    expect(peekAgentPromptId("chat_adopt")).toBe("prompt-adopt-1");

    trackAgentPermissionDecided({
      chatId: "chat_adopt",
      agentId: "codex",
      decision: "allow_once",
      toolKind: "execute",
    });
    expect(capture.mock.calls.at(-1)?.[1]).toMatchObject({
      prompt_id: "prompt-adopt-1",
      decision: "allow_once",
    });

    trackAgentPromptFinished({
      promptId: "prompt-adopt-1",
      chatId: "chat_adopt",
      agentId: "codex",
      outcome: "completed",
      durationMs: 1200,
      retryCount: 0,
    });
    trackAgentPromptFinished({
      promptId: "prompt-adopt-1",
      chatId: "chat_adopt",
      agentId: "codex",
      outcome: "completed",
      durationMs: 1200,
      retryCount: 0,
    });

    const finished = capture.mock.calls.filter(
      ([event]) => event === "agent_prompt_finished",
    );
    expect(finished).toHaveLength(1);
    expect(peekAgentPromptId("chat_adopt")).toBeUndefined();
  });

  it("coarsens untrusted model/mode/action strings before analytics or logs", () => {
    trackAiGeneration({
      agentId: "cursor",
      model: "/Users/alice/private model alice@example.com",
      traceId: "/tmp/private-trace",
      latencyMs: 10,
      inputTokens: 1,
    });
    const aiProps = capture.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    assertCleanProps(aiProps);
    expect(aiProps.$ai_model).toBe("custom");
    expect(aiProps.$ai_trace_id).toBe("custom");

    trackAgentPromptStarted({
      promptId: "prompt_unsafe",
      chatId: "chat_unsafe",
      agentId: "cursor",
      requestedModel: "alice_private_model",
      effort: "high\nsecret",
      permissionMode: "auto",
      nativeMode: "/tmp/mode",
      fastEnabled: false,
      contentBlockCount: 1,
      imageAttachmentCount: 0,
      textAttachmentCount: 0,
      mentionFileCount: 0,
      mentionFolderCount: 0,
      mentionSelectionCount: 0,
      additionalDirectoryCount: 0,
      isAutoAction: true,
      autoActionKind: "deploy /Users/alice/private",
    });

    const props = capture.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    assertCleanProps(props);
    expect(props.requested_model).toBe("custom");
    expect(props.native_mode).toBe("custom");
    expect(props.auto_action_kind).toBe("custom");
  });

  it("trackGitOp scrubs a raw error to a safe enum — a path/email in it never reaches analytics", () => {
    // A raw Error whose message carries a path + email — the kind of content that
    // must never be sent. gitErrorKind extracts ONLY a structured `code`, so a raw
    // Error classifies to "unknown" and the message is dropped.
    trackGitOp({
      op: "commit",
      outcome: "error",
      error: new Error(
        "failed at /Users/alice/secret/repo by alice@example.com",
      ),
    });
    const last = capture.mock.calls.at(-1);
    expect(last?.[0]).toBe("git_op");
    const props = last?.[1] as Record<string, unknown>;
    expect(props.error_kind).toBe("unknown");
    assertCleanProps(props);

    // A structured GitError-like object → its enum `code` passes through (safe).
    capture.mockClear();
    trackGitOp({
      op: "push",
      outcome: "error",
      error: { code: "REMOTE_REJECTED" },
    });
    const props2 = capture.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(props2.error_kind).toBe("REMOTE_REJECTED");
    assertCleanProps(props2);
  });

  it("trackAgentFailed builds the exception from enums only; non-bug kinds don't raise", () => {
    trackAgentFailed({
      agentId: "cursor",
      failure: { kind: "protocol-error", stage: "prompt" },
    });
    // a fix-worthy fault → captureException with enum-only props
    expect(captureException).toHaveBeenCalledTimes(1);
    const [, props] = captureException.mock.calls[0];
    assertCleanProps(props as Record<string, unknown>);

    // a non-bug, user-correctable failure → captured as event but NOT an exception
    captureException.mockClear();
    trackAgentFailed({
      agentId: "cursor",
      failure: { kind: "auth-required", stage: "newSession" },
    });
    expect(captureException).not.toHaveBeenCalled();
  });

  it("trackAgentFailed hashes the technical message — never sends it raw", () => {
    // Adversarial message: path + email + volatile pid. Only a short hex hash
    // may reach analytics.
    trackAgentFailed({
      agentId: "cursor",
      failure: {
        kind: "protocol-error",
        stage: "newSession",
        message:
          "cursor host: /Users/alice/secret/host.cjs exited (pid 4321) — mail alice@example.com",
      },
    });
    const eventProps = capture.mock.calls.at(-1)?.[1] as Record<
      string,
      unknown
    >;
    const excProps = captureException.mock.calls.at(-1)?.[1] as Record<
      string,
      unknown
    >;
    for (const props of [eventProps, excProps]) {
      assertCleanProps(props);
      expect(props.message_hash).toMatch(/^[0-9a-f]{8}$/);
    }

    // Same fault with different volatile bits (path, pid) → SAME hash, so
    // recurrences group in PostHog.
    capture.mockClear();
    trackAgentFailed({
      agentId: "cursor",
      failure: {
        kind: "protocol-error",
        stage: "newSession",
        message:
          "cursor host: /Users/bob/other/host.cjs exited (pid 99) — mail alice@example.com",
      },
    });
    const rehashed = (capture.mock.calls.at(-1)?.[1] as Record<string, unknown>)
      .message_hash;
    expect(rehashed).toBe(eventProps.message_hash);

    // A genuinely different message → different hash (faults stay distinguishable).
    capture.mockClear();
    trackAgentFailed({
      agentId: "cursor",
      failure: {
        kind: "protocol-error",
        stage: "newSession",
        message: "TLS handshake rejected",
      },
    });
    const other = (capture.mock.calls.at(-1)?.[1] as Record<string, unknown>)
      .message_hash;
    expect(other).toMatch(/^[0-9a-f]{8}$/);
    expect(other).not.toBe(eventProps.message_hash);

    // No message → no hash prop (undefined is fine, never an empty string).
    capture.mockClear();
    trackAgentFailed({
      agentId: "cursor",
      failure: { kind: "timeout", stage: "prompt" },
    });
    expect(
      (capture.mock.calls.at(-1)?.[1] as Record<string, unknown>).message_hash,
    ).toBeUndefined();
  });
});
