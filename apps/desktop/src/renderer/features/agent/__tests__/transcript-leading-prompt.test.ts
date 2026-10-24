import { beforeEach, describe, expect, it } from "vitest";
import type { AgentMessage, AgentTextMessage } from "../use-agent-session";
import { BLANK, useSessionsStore } from "../sessions-store";
import {
  capMessagesKeepingLeadingPrompt,
  presentLeadingPrompt,
  settleLeadingPrompt,
} from "../transcript-leading-prompt";
import { groupMessagesIntoTurns } from "../turn-grouping";
import { canReplaceCloudTranscript } from "../local-transcript-presentation";
import { transcriptMessageSignature } from "../../../state/local-transcript-cache";

const user = (id: string, extra: Partial<AgentTextMessage> = {}): AgentTextMessage => ({
  id, kind: "text", role: "user", text: `ask ${id}`, createdAt: 1, ...extra,
});
const agent = (id: string): AgentMessage => ({ id, kind: "text", role: "agent", text: id, createdAt: 1 });
const tools = (prefix: string, count: number): AgentMessage[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `${prefix}${index}`, kind: "tool", toolCallId: `${prefix}${index}`, title: "Read",
    status: "completed", createdAt: 1, updatedAt: 1,
  }) as AgentMessage);

describe("leading prompt beside a window that starts inside a turn", () => {
  beforeEach(() => useSessionsStore.getState().clearAll());

  it.each(["updated front", "trimmed front", "prepended history"] as const)(
    "retains the opening by message identity after %s",
    (change) => {
      const opening = user("u1");
      const tail = tools("t", 3);
      const updated = tail.map(message => ({ ...message, updatedAt: 2 }));
      const next = change === "trimmed front" ? updated.slice(1)
        : change === "prepended history" ? [...tools("older", 2), ...updated] : updated;
      expect(settleLeadingPrompt(tail, opening, next, undefined)).toBe(opening);
    },
  );

  it("derives the next turn's opening when trimming onto an updated row", () => {
    const nextOpening = user("u2");
    const tail = tools("t", 3);
    const previous = [...tools("old", 2), nextOpening, ...tail];
    expect(settleLeadingPrompt(previous, user("u1"), tail.map(message => ({ ...message })), undefined)).toBe(nextOpening);
  });

  it.each(["/repo", "/organization/repo"])("keeps the opening when the first resident tool completes in %s", (cwd) => {
    const opening = user("u1");
    const messages = tools("t", 200);
    messages[0] = { ...messages[0], status: "in_progress" } as AgentMessage;
    const store = useSessionsStore.getState();
    store.setSession("chat", {
      ...BLANK, cwd, agentId: "claude", sessionId: "session", status: "streaming",
      transcriptState: "resident", messages, leadingPrompt: opening,
    });
    store.applyBridgeUpdate({
      sessionId: "session",
      update: { sessionUpdate: "tool_call_update", toolCallId: "t0", status: "completed" },
    });
    const after = useSessionsStore.getState().sessions.chat;
    expect(after.messages[0]).toMatchObject({ id: "t0", status: "completed" });
    expect(after.messages[0]).not.toBe(messages[0]);
    expect(after.leadingPrompt).toBe(opening);
    expect(groupMessagesIntoTurns(presentLeadingPrompt(after.messages, after.leadingPrompt))[0].userPrompt).toBe(opening);
  });

  it("keeps cloud windows on their existing prompt path", () => {
    const cwd = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
    const store = useSessionsStore.getState();
    store.setSession("cloud-chat", { ...BLANK, cwd, messages: tools("t", 2), leadingPrompt: user("u1") });
    store.patchSession("cloud-chat", { messages: tools("t", 2) });
    expect(useSessionsStore.getState().sessions["cloud-chat"].leadingPrompt).toBeNull();
  });

  it.each([undefined, { id: "opening", kind: "text", role: "agent" }])("ignores an invalid recorded-message payload before changing the retained opening (%j)", message => {
    const store = useSessionsStore.getState();
    store.setSession("chat", { ...BLANK, cwd: "/repo", sessionId: "session", transcriptState: "resident",
      messages: [agent("answer")], leadingPrompt: user("opening") });
    const before = useSessionsStore.getState().sessions.chat;
    expect(() => store.applyBridgeUpdate({ sessionId: "session", update: {
      sessionUpdate: "user_message_recorded", message,
    } } as never)).not.toThrow();
    expect(useSessionsStore.getState().sessions.chat).toBe(before);
  });

  it.each([false, true])("rejects a stale mirrored opening after its cached provenance was replaced live (leading: %s)", leading => {
    const chatId = "cloud:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222:chat";
    const cwd = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
    const opening = user("opening"), answer = agent("answer");
    const store = useSessionsStore.getState();
    store.setSession(chatId, { ...BLANK, cwd, sessionId: "session", transcriptState: "resident", transcriptSource: "worker",
      messages: leading ? [answer] : [opening, answer], leadingPrompt: leading ? opening : null, transcriptContentSignatures: {
        opening: transcriptMessageSignature(opening)!, answer: transcriptMessageSignature(answer)!,
      } });
    store.applyBridgeUpdate({ sessionId: "session", update: {
      sessionUpdate: "user_message_recorded", message: { ...opening, updatedAt: 2, turnSummary: {
        agentId: "claude", ord: 1, summary: "Edit", startedAt: 1, endedAt: 2, status: "completed", stopReason: "end_turn",
        files: [{ path: "file.ts", status: "modified", additions: 2, deletions: 1 }],
      } },
    } });
    const after = useSessionsStore.getState().sessions[chatId];
    expect(canReplaceCloudTranscript(after, { messages: leading ? [answer] : [opening, answer],
      ...(leading ? { leadingPrompt: opening } : {}), source: "control-plane" })).toBe(false);
    expect(after.transcriptContentSignatures?.answer).toBe(transcriptMessageSignature(answer));
  });

  it.each([
    { chatId: "personal-chat", cwd: "/personal/repo" },
    { chatId: "organization-chat", cwd: "/organization/repo" },
    { chatId: "cloud:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222:chat", cwd: "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222" },
  ])("updates $cwd recorded changes beside a long tail without appending its opening again", ({ chatId, cwd }) => {
    const opening = user("opening", { messageId: "native-opening" });
    const messages = [...tools("t", 200), agent("answer")];
    const store = useSessionsStore.getState();
    store.setSession(chatId, { ...BLANK, cwd, agentId: "claude", sessionId: "session", status: "ready",
      transcriptState: "resident", messages, leadingPrompt: opening });
    const turnSummary: NonNullable<AgentTextMessage["turnSummary"]> = {
      agentId: "claude", ord: 1, summary: "Change files", startedAt: 1, endedAt: 2,
      status: "completed", stopReason: "end_turn", files: [{ path: "file.ts", status: "added", additions: 3, deletions: 0 }],
    };
    store.applyBridgeUpdate({ sessionId: "session", update: {
      sessionUpdate: "user_message_recorded", message: user("opening", { turnSummary }),
    } });
    const after = useSessionsStore.getState().sessions[chatId];
    expect(after.messages).toBe(messages);
    expect(after.leadingPrompt).toMatchObject({ id: "opening", messageId: "native-opening", turnSummary });
    const turns = groupMessagesIntoTurns(presentLeadingPrompt(after.messages, after.leadingPrompt));
    expect(turns).toHaveLength(1);
    expect(turns[0].recordedSummary).toBe(turnSummary);
    expect(turns[0].events.at(-1)?.id).toBe("answer");
  });

  it("renders the opening prompt above a headless first turn", () => {
    const opening = user("u1");
    const tail = tools("t", 3);
    const turns = groupMessagesIntoTurns(presentLeadingPrompt(tail, opening));
    expect(turns).toHaveLength(1);
    expect(turns[0].userPrompt?.id).toBe("u1");
    expect(turns[0].events.map((event) => event.id)).toEqual(["t0", "t1", "t2"]);
  });

  it("never duplicates or reorders a prompt that is already in the window", () => {
    const messages = [user("u1"), ...tools("t", 2)];
    expect(presentLeadingPrompt(messages, user("u1"))).toBe(messages);
    const startsOnPrompt = [user("u2"), agent("a2")];
    expect(presentLeadingPrompt(startsOnPrompt, user("u1"))).toBe(startsOnPrompt);
    const paged = [...tools("old", 2), user("u1"), ...tools("t", 2)];
    expect(presentLeadingPrompt(paged, user("u1"))).toBe(paged);
    expect(presentLeadingPrompt([], user("u1"))).toEqual([]);
  });

  it("keeps the opening prompt when the live cap trims the front of a long turn", () => {
    const messages = [user("u0"), agent("a0"), user("u1"), ...tools("t", 10)];
    const capped = capMessagesKeepingLeadingPrompt(messages, 5, null);
    expect(capped.messages.map((message) => message.id)).toEqual(["t5", "t6", "t7", "t8", "t9"]);
    expect(capped.leadingPrompt?.id).toBe("u1");
    // Trimming again inside the same turn keeps the known opening.
    const more = [...capped.messages, ...tools("x", 3)];
    const again = capMessagesKeepingLeadingPrompt(more, 5, capped.leadingPrompt);
    expect(again.messages[0].id).toBe("t8");
    expect(again.leadingPrompt?.id).toBe("u1");
    // Under the cap: unchanged references.
    expect(capMessagesKeepingLeadingPrompt(messages, 50, null).messages).toBe(messages);
  });

  it("follows a steer back to the turn's real opening when trimming", () => {
    const opening = user("u1");
    const messages = [opening, ...tools("t", 3), user("s1", { steeredTurnId: "u1" }), ...tools("x", 3)];
    expect(capMessagesKeepingLeadingPrompt(messages, 2, null).leadingPrompt?.id).toBe("u1");
    // The opening already left in an earlier trim: the remembered one still owns the steer.
    const onlySteer = [user("s1", { steeredTurnId: "u1" }), ...tools("x", 3)];
    expect(capMessagesKeepingLeadingPrompt(onlySteer, 2, opening).leadingPrompt?.id).toBe("u1");
  });

  it("settles the leading prompt across appends, prepends and replacements", () => {
    const opening = user("u1");
    const tail = tools("t", 3);
    // Same front (streaming append): unchanged.
    expect(settleLeadingPrompt(tail, opening, [...tail, agent("a")], undefined)).toBe(opening);
    // Older rows from the same turn prepended: unchanged.
    expect(settleLeadingPrompt(tail, opening, [...tools("o", 2), ...tail], undefined)).toBe(opening);
    // A page that reached the opening: it is in-line now.
    expect(settleLeadingPrompt(tail, opening, [opening, ...tail], undefined)).toBeNull();
    // A page that went past the opening into an earlier turn: that turn's
    // prompt is unknown, never borrowed from the later turn.
    expect(settleLeadingPrompt(tail, opening, [...tools("e", 1), user("u1"), ...tail], undefined)).toBeNull();
    // Front trimmed inside the same turn: unchanged.
    expect(settleLeadingPrompt(tail, opening, tail.slice(1), undefined)).toBe(opening);
    // Wholesale replacement uses only an explicit proposal.
    expect(settleLeadingPrompt(tail, opening, tools("n", 2), undefined)).toBeNull();
    expect(settleLeadingPrompt(tail, opening, tools("n", 2), user("u9"))?.id).toBe("u9");
    // An explicit proposal that is not a user prompt is ignored.
    expect(settleLeadingPrompt([], null, tail, agent("a") as AgentTextMessage)).toBeNull();
    // Empty or prompt-first windows never carry one.
    expect(settleLeadingPrompt(tail, opening, [], undefined)).toBeNull();
    expect(settleLeadingPrompt(tail, opening, [user("u2")], undefined)).toBeNull();
  });
});
