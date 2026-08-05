// Coverage for the blocking-question interaction queue in the sessions store:
//   - applyBridgeQuestionRequest APPENDS (never clobbers) and routes by sessionId
//   - dedup on nativeRequestId (SDK replays an in-flight request on reconnect
//     with a fresh questionId) AND on questionId
//   - applyBridgeAgentExit evicts a parked question EVEN for a streaming
//     (activelyDriven) session — a dead session's card must not linger.

import { beforeEach, describe, expect, it } from "vitest";

import {
  useSessionsStore,
  BLANK,
  buildQuestionStamp,
  readQuestionStamp,
  type QuestionRecordStamp,
} from "../sessions-store";
import type { QuestionRequest } from "../../../platform/bridge/agent-events";

const seed = (
  chatId: string,
  agentId: string,
  sessionId: string,
  status: string,
) =>
  useSessionsStore.getState().setSession(chatId, {
    ...BLANK,
    agentId,
    sessionId,
    status: status as never,
  });

const req = (
  sessionId: string,
  over: Partial<QuestionRequest> = {},
): QuestionRequest => ({
  sessionId: sessionId as never,
  questionId: over.questionId ?? "q-1",
  nativeRequestId: over.nativeRequestId ?? "native-1",
  source: "native_dialog",
  blocking: true,
  questions: over.questions ?? [
    { id: "q0", prompt: "Pick one", options: [], allowOther: true },
  ],
  ...over,
});

describe("applyBridgeQuestionRequest — queue semantics", () => {
  beforeEach(() => {
    useSessionsStore.getState().clearAll();
    seed("chatA", "claude", "sidA", "streaming");
  });

  it("appends a question routed by sessionId", () => {
    useSessionsStore
      .getState()
      .applyBridgeQuestionRequest("claude", "q-1", req("sidA"));
    const s = useSessionsStore.getState().sessions["chatA"];
    expect(s?.pendingQuestions.map((q) => q.questionId)).toEqual(["q-1"]);
  });

  it("appends a SECOND distinct question (no clobber, arrival order)", () => {
    const store = useSessionsStore.getState();
    store.applyBridgeQuestionRequest("claude", "q-1", req("sidA"));
    store.applyBridgeQuestionRequest(
      "claude",
      "q-2",
      req("sidA", { questionId: "q-2", nativeRequestId: "native-2" }),
    );
    const s = useSessionsStore.getState().sessions["chatA"];
    expect(s?.pendingQuestions.map((q) => q.questionId)).toEqual(["q-1", "q-2"]);
  });

  it("dedupes a replayed request by nativeRequestId (fresh questionId)", () => {
    const store = useSessionsStore.getState();
    store.applyBridgeQuestionRequest("claude", "q-1", req("sidA"));
    // Reconnect: same underlying request, NEW questionId, SAME nativeRequestId.
    store.applyBridgeQuestionRequest(
      "claude",
      "q-1-replay",
      req("sidA", { questionId: "q-1-replay", nativeRequestId: "native-1" }),
    );
    const s = useSessionsStore.getState().sessions["chatA"];
    expect(s?.pendingQuestions).toHaveLength(1);
    expect(s?.pendingQuestions[0]?.questionId).toBe("q-1");
  });

  it("dedupes an exact-questionId re-delivery", () => {
    const store = useSessionsStore.getState();
    store.applyBridgeQuestionRequest("claude", "q-1", req("sidA"));
    store.applyBridgeQuestionRequest("claude", "q-1", req("sidA"));
    expect(
      useSessionsStore.getState().sessions["chatA"]?.pendingQuestions,
    ).toHaveLength(1);
  });

  it("ignores a request whose sessionId maps to no chat", () => {
    useSessionsStore
      .getState()
      .applyBridgeQuestionRequest("claude", "q-x", req("unknown-sid"));
    expect(
      useSessionsStore.getState().sessions["chatA"]?.pendingQuestions,
    ).toHaveLength(0);
  });
});

describe("stampQuestionAnswer — durable resolution record", () => {
  beforeEach(() => {
    useSessionsStore.getState().clearAll();
  });

  const seedWithToolMsg = () =>
    useSessionsStore.getState().setSession("chatA", {
      ...BLANK,
      agentId: "claude",
      sessionId: "sidA",
      status: "streaming" as never,
      messages: [
        {
          id: "m1",
          kind: "tool",
          toolCallId: "tc-1",
          title: "AskUserQuestion",
          toolKind: "question",
          status: "completed",
          createdAt: 0,
          updatedAt: 0,
        } as never,
      ],
    });

  it("stamps the resolution onto the matching transcript tool message", () => {
    seedWithToolMsg();

    const stamp: QuestionRecordStamp = {
      outcome: "answered",
      summary: "Defer git UI entirely",
      answers: [{ prompt: "Pick one", value: "Defer git UI entirely" }],
    };
    useSessionsStore.getState().stampQuestionAnswer("chatA", "tc-1", stamp);

    const msg = useSessionsStore.getState().sessions["chatA"]?.messages[0] as {
      rawOutput?: unknown;
    };
    expect(readQuestionStamp(msg.rawOutput)).toEqual(stamp);
  });

  it("matches through nativeToolCallId (translator uuid ≠ vendor id)", () => {
    useSessionsStore.getState().setSession("chatA", {
      ...BLANK,
      agentId: "claude",
      sessionId: "sidA",
      status: "streaming" as never,
      messages: [
        {
          id: "m1",
          kind: "tool",
          toolCallId: "uuid-minted-by-translator",
          nativeToolCallId: "toolu_native",
          title: "AskUserQuestion",
          toolKind: "question",
          status: "in_progress",
          createdAt: 0,
          updatedAt: 0,
        } as never,
      ],
    });

    // The QuestionRequest carries the VENDOR id — the stamp must land anyway.
    useSessionsStore
      .getState()
      .stampQuestionAnswer("chatA", "toolu_native", { outcome: "skipped" });

    const msg = useSessionsStore.getState().sessions["chatA"]?.messages[0] as {
      rawOutput?: unknown;
    };
    expect(readQuestionStamp(msg.rawOutput)?.outcome).toBe("skipped");

    // And the ack-watchdog's re-queue path can clear it again (record
    // returns to AWAITING).
    useSessionsStore.getState().clearQuestionStamp("chatA", "toolu_native");
    const cleared = useSessionsStore.getState().sessions["chatA"]
      ?.messages[0] as { rawOutput?: unknown };
    expect(readQuestionStamp(cleared.rawOutput)).toBeNull();
  });

  it("no-ops when no message matches the toolCallId", () => {
    useSessionsStore.getState().setSession("chatA", {
      ...BLANK,
      agentId: "claude",
      sessionId: "sidA",
      messages: [],
    });
    // Should not throw.
    useSessionsStore
      .getState()
      .stampQuestionAnswer("chatA", "missing", { outcome: "skipped" });
    expect(
      useSessionsStore.getState().sessions["chatA"]?.messages,
    ).toHaveLength(0);
  });
});

describe("buildQuestionStamp", () => {
  const request = req("sidA", {
    toolCallId: "tc-1",
    questions: [
      {
        id: "q0",
        prompt: "Pick one",
        options: [
          { id: "o0", label: "Zustand" },
          { id: "o1", label: "Redux" },
        ],
        allowOther: true,
      },
    ],
  });

  it("maps option ids back to labels and joins free-text", () => {
    const stamp = buildQuestionStamp(request, {
      outcome: "answered",
      answers: [
        { questionId: "q0", selectedOptionIds: ["o1"], freeText: "or jotai" },
      ],
    });
    expect(stamp.outcome).toBe("answered");
    expect(stamp.answers).toEqual([
      { prompt: "Pick one", value: "Redux, or jotai" },
    ]);
    expect(stamp.summary).toBe("Redux, or jotai");
  });

  it("maps a dismissal to a skipped stamp", () => {
    expect(buildQuestionStamp(request, { outcome: "dismissed" })).toEqual({
      outcome: "skipped",
    });
  });
});

describe("applyBridgeQuestionSettled — engine-side settles evict + stamp", () => {
  beforeEach(() => {
    useSessionsStore.getState().clearAll();
  });

  it("evicts the queued question and stamps its tool record skipped", () => {
    useSessionsStore.getState().setSession("chatA", {
      ...BLANK,
      agentId: "claude",
      sessionId: "sidA",
      status: "streaming" as never,
      messages: [
        {
          id: "m1",
          kind: "tool",
          toolCallId: "tc-1",
          title: "AskUserQuestion",
          toolKind: "question",
          status: "completed",
          createdAt: 0,
          updatedAt: 0,
        } as never,
      ],
    });
    useSessionsStore
      .getState()
      .applyBridgeQuestionRequest(
        "claude",
        "q-1",
        req("sidA", { toolCallId: "tc-1" }),
      );

    useSessionsStore
      .getState()
      .applyBridgeQuestionSettled("q-1", { outcome: "dismissed" });

    const slot = useSessionsStore.getState().sessions["chatA"];
    expect(slot?.pendingQuestions).toHaveLength(0);
    const msg = slot?.messages[0] as { rawOutput?: unknown };
    expect(readQuestionStamp(msg?.rawOutput)?.outcome).toBe("skipped");
  });

  it("no-ops for a questionId no chat holds (already answered locally)", () => {
    seed("chatA", "claude", "sidA", "streaming");
    // Should not throw or change anything.
    useSessionsStore
      .getState()
      .applyBridgeQuestionSettled("q-gone", { outcome: "dismissed" });
    expect(
      useSessionsStore.getState().sessions["chatA"]?.pendingQuestions,
    ).toHaveLength(0);
  });
});

describe("applyBridgeAgentExit — evicts parked questions", () => {
  beforeEach(() => {
    useSessionsStore.getState().clearAll();
  });

  it("clears a parked question on a STREAMING (activelyDriven) crash", () => {
    seed("chatA", "claude", "sidA", "streaming");
    useSessionsStore
      .getState()
      .applyBridgeQuestionRequest("claude", "q-1", req("sidA"));
    expect(
      useSessionsStore.getState().sessions["chatA"]?.pendingQuestions,
    ).toHaveLength(1);

    useSessionsStore.getState().applyBridgeAgentExit("claude", "sidA");

    const s = useSessionsStore.getState().sessions["chatA"];
    // Card evicted even though the streaming status is preserved for prompt-retry.
    expect(s?.pendingQuestions).toHaveLength(0);
    expect(s?.status).toBe("streaming");
  });
});
