import { describe, expect, it } from "vitest";
import { applyUpdate, type AgentMessage } from "@zeros/protocol/agent-messages";
import { partitionTurnSequence } from "../turn-partition";
import { turnFailureForCard } from "../turn-failure";

const turnId = "prompt";
const tool: AgentMessage = {
  id: "tool",
  kind: "tool",
  toolCallId: "tool",
  toolKind: "execute",
  title: "Bash",
  status: "failed",
  rawInput: { command: "pnpm verify" },
  rawOutput: "Verification failed",
  createdAt: 1,
  updatedAt: 1,
};
const terminal: AgentMessage = {
  id: "terminal",
  kind: "error_notice",
  severity: "error",
  recoverable: false,
  message: "Provider could not complete the turn.",
  createdAt: 2,
  turnFailure: { turnId, kind: "protocol-error" },
};
const displayed = (
  events: AgentMessage[],
  failureTurnId?: string,
  live = false,
) =>
  partitionTurnSequence(events, { failureTurnId, live }).flatMap(
    (segment) => segment.events,
  );

describe("turn failure presentation", () => {
  it.each(["claude", "codex", "cursor"])(
    "renders a persisted %s failure only in the footer, retaining failed tools",
    (provider) => {
      let events = [tool];
      // Codex can emit an untagged native error before the engine persists its
      // turn-owned failure. Both describe the terminal failure, not tool calls.
      if (provider === "codex") {
        events = applyUpdate(events, {
          sessionId: "session",
          update: {
            sessionUpdate: "error_notice",
            noticeId: "native-error",
            severity: "error",
            message: "Codex: Provider could not complete the turn.",
          },
        });
      }
      events = applyUpdate(events, {
        sessionId: "session",
        update: {
          sessionUpdate: "error_notice",
          noticeId: "engine-error",
          severity: "error",
          recoverable: false,
          message: `${provider}: Provider could not complete the turn.`,
          turnFailure: { turnId, kind: "protocol-error" },
        },
      });
      const history: AgentMessage[] = JSON.parse(JSON.stringify(events));
      expect(displayed(history, turnId)).toEqual([tool]);
      expect(
        turnFailureForCard({ events: history, turnId, status: "failed" })
          ?.message,
      ).toBe(`${provider}: Provider could not complete the turn.`);
      expect(history.length).toBe(provider === "codex" ? 3 : 2);
    },
  );

  it("does not leave an empty activity group for a failure before any work", () => {
    expect(
      partitionTurnSequence([terminal], { failureTurnId: turnId }),
    ).toEqual([]);
  });

  it("keeps errors visible while live and in feeds without a failure footer", () => {
    expect(displayed([terminal], turnId, true)).toEqual([terminal]);
    expect(displayed([terminal])).toEqual([terminal]);
  });

  it("shows one live terminal notice outside activity before the footer settles", () => {
    const native = { ...terminal, id: "native", turnFailure: undefined };
    expect(
      partitionTurnSequence([tool, native, terminal], {
        failureTurnId: turnId,
        live: true,
      }),
    ).toEqual([
      { kind: "working", key: tool.id, events: [tool] },
      { kind: "output", key: terminal.id, events: [terminal] },
    ]);
  });

  it("preserves recoverable warnings, child errors and errors owned by another turn", () => {
    const retained: AgentMessage[] = [
      { ...terminal, id: "retry", recoverable: true, code: "api_retry" },
      { ...terminal, id: "warning", severity: "warning" },
      { ...terminal, id: "child", parentToolId: "agent" },
      {
        ...terminal,
        id: "other",
        turnFailure: { turnId: "other-prompt", kind: "protocol-error" },
      },
    ];
    expect(displayed([...retained, terminal], turnId)).toEqual(retained);
  });

  it("does not promote unfinished phase-less narration into a final answer", () => {
    const narration: AgentMessage = {
      id: "narration",
      kind: "text",
      role: "agent",
      text: "Checking the result.",
      createdAt: 1,
    };
    const sequence = partitionTurnSequence([narration, terminal], {
      failureTurnId: turnId,
    });
    expect(sequence).toEqual([
      { kind: "working", key: narration.id, events: [narration] },
    ]);
  });

  it("retains the answer and footer for a late background failure", () => {
    const answer: AgentMessage = {
      id: "answer",
      kind: "text",
      role: "agent",
      text: "The changes are ready.",
      createdAt: 1,
    };
    const background = { ...terminal, code: "claude-background-failed" };
    expect(
      partitionTurnSequence([answer, background], { failureTurnId: turnId }),
    ).toEqual([{ kind: "output", key: answer.id, events: [answer] }]);
    expect(
      turnFailureForCard({
        events: [answer, background],
        turnId,
        status: "completed",
      }),
    ).toMatchObject({ message: terminal.message });
  });

  it("retains disclosure identity when a live failure transfers to the footer", () => {
    const events = [tool, terminal];
    const live = partitionTurnSequence(events, {
      live: true,
      failureTurnId: turnId,
    });
    const settled = partitionTurnSequence(
      events,
      { failureTurnId: turnId },
      live,
    );
    expect(settled).toEqual([
      { kind: "working", key: live[0].key, events: [tool] },
    ]);
  });
});
