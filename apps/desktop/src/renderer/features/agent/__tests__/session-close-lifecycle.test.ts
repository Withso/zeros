import { describe, expect, it } from "vitest";

import {
  closeActivityForSession,
  closeRouteForSession,
} from "../session-close-lifecycle";

describe("closeRouteForSession", () => {
  it("builds a conversation-only close when a tab has no resident slot", () => {
    expect(closeRouteForSession(undefined)).toEqual({});
  });

  it("uses the canonical execution route when a resident slot exists", () => {
    expect(
      closeRouteForSession({
        executionId: "execution-new",
        sessionId: "execution-compat",
      }),
    ).toEqual({
      executionId: "execution-new",
      sessionId: "execution-new",
    });
  });

  it("falls back to the protocol-v8 route when no canonical field exists", () => {
    expect(closeRouteForSession({ sessionId: "execution-compat" })).toEqual({
      executionId: "execution-compat",
      sessionId: "execution-compat",
    });
  });
});

describe("closeActivityForSession", () => {
  it("covers an adopted turn and provider-owned background work", () => {
    expect(
      closeActivityForSession(
        {
          status: "streaming",
          messages: [],
          backgroundTasks: [],
          workflows: [],
          waitingForBackgroundTasks: false,
        },
        { localSendInFlight: false, queuedCount: 0 },
      ),
    ).toEqual({ running: true, queuedCount: 0 });

    expect(
      closeActivityForSession(
        {
          status: "ready",
          messages: [],
          backgroundTasks: [{ taskId: "task-1" }],
          workflows: [],
          waitingForBackgroundTasks: false,
        },
        { localSendInFlight: false, queuedCount: 0 },
      ),
    ).toEqual({ running: true, queuedCount: 0 });
  });

  it("covers a prompt waiting for session startup and queued bubbles", () => {
    expect(
      closeActivityForSession(
        {
          status: "warming",
          messages: [{ kind: "text", queued: true }],
          backgroundTasks: [],
          workflows: [],
          waitingForBackgroundTasks: false,
        },
        { localSendInFlight: true, queuedCount: 1 },
      ),
    ).toEqual({ running: true, queuedCount: 1 });
  });

  it("treats a missing or idle slot as inactive", () => {
    expect(
      closeActivityForSession(undefined, {
        localSendInFlight: false,
        queuedCount: 0,
      }),
    ).toEqual({ running: false, queuedCount: 0 });
  });
});
