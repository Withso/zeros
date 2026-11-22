// Production prompt bubbles, in-between narration and final output with their
// hover popups, laid out in AgentChat's transcript column.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import { createRoot } from "react-dom/client";
import type { AgentMessage, AgentToolMessage } from "@zeros/protocol/agent-messages";
import { TurnContainer, TurnPromptHeader } from "../features/agent/turn-container";
import { TurnEventList } from "../features/agent/turn-event-list";
import { groupMessagesIntoTurns, turnKey } from "../features/agent/turn-grouping";
import type { RendererContext } from "../features/agent/renderers/types";
import { TooltipProvider } from "../shared/ui/primitives/tooltip";

const at = Date.parse("2026-11-22T10:50:00");
const prompt = (id: string, text: string): AgentMessage => ({ id, kind: "text", role: "user", text, createdAt: at });
const reply = (id: string, text: string, phase?: "commentary" | "final_answer"): AgentMessage =>
  ({ id, kind: "text", role: "agent", text, phase, messageId: `engine-${id}`, createdAt: at });
const tool = (id: string): AgentToolMessage => ({
  id, kind: "tool", toolCallId: id, toolKind: "execute", title: "Bash", status: "completed",
  rawInput: { command: `echo ${id}` }, rawOutput: `ran ${id}`, createdAt: at, updatedAt: at, settledAt: at,
});

const messages: AgentMessage[] = [
  prompt("p1", "Inspect the repository and summarize the build. Reply only with the build tool and its version, nothing else."),
  reply("a1", "Reading the package manifest to find the build tool and its pinned version before answering.", "commentary"),
  tool("t1"),
  reply("a2", "The manifest pins the bundler, so the lockfile confirms the exact version used by the build pipeline.", "commentary"),
  tool("t2"),
  reply("a3", "Vite 7.1.4 is the build tool, pinned in the root package manifest and resolved the same in the lockfile.", "final_answer"),
  prompt("p2", "Which file holds the session? Reply only with the path and nothing else at all."),
  reply("a4", "apps/desktop/src/renderer/features/agent/use-agent-session.ts holds the session store and its reducer.", "final_answer"),
];

const ctx: RendererContext = {
  isStreaming: false,
  lastMessageId: null,
  activeTurnStartedAt: at,
  editBaselines: new Map(),
  pendingPermission: null,
  pendingQuestionToolCallIds: new Set(),
  chatId: "message-hover-harness",
  setMode: null,
  subagentChildren: new Map(),
  respondToQuestion: () => {},
  respondToPermission: () => {},
  retrySafetyReview: async () => {},
  recordPolicy: () => {},
  editAndResubmit: () => {},
  openSideChat: () => {},
  warmSideChat: () => {},
};

const turns = groupMessagesIntoTurns(messages);

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <main className="bg-bg1 text-fg1 min-h-screen">
      <div id="message-hover-transcript" className="zeros-agent-messages mx-auto flex w-full max-w-(--chat-column) min-w-0 flex-col gap-5 px-7 pt-8 pb-8">
        {turns.map((turn, index) => (
          <TurnContainer key={turnKey(turn)} turn={turn} isActive={index === turns.length - 1}>
            {turn.userPrompt && (
              <TurnPromptHeader
                chatId={ctx.chatId ?? undefined}
                messageId={turn.userPrompt.id}
                createdAt={turn.userPrompt.createdAt}
                originalText={turn.userPrompt.text}
                onEdit={() => {}}
                onSideChat={() => {}}
              >
                {turn.userPrompt.text}
              </TurnPromptHeader>
            )}
            <TurnEventList events={turn.events} isActive={false} isStreaming={false} showActivity={false} surfaceActive ctx={ctx} />
          </TurnContainer>
        ))}
      </div>
    </main>
  </TooltipProvider>,
);
