// Development-only fixtures exercising the production transcript components.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { applyUpdate, type AgentMessage } from "@zeros/protocol/agent-messages";
import type {
  QuestionRequest,
  QuestionResponse,
  SessionUpdate,
} from "@zeros/protocol/agent-events";
import { TurnEventList } from "../features/agent/turn-event-list";
import { QuestionCard } from "../features/agent/question-card";
import type { RendererContext } from "../features/agent/renderers/types";
import { Button } from "../shared/ui/primitives/button";
import { Textarea } from "../shared/ui/primitives/textarea";
import { TooltipProvider } from "../shared/ui/primitives/tooltip";

const initial: SessionUpdate[] = [
  {
    sessionUpdate: "agent_message_chunk",
    messageId: "progress",
    phase: "commentary",
    content: { type: "text", text: "I am checking the implementation." },
  },
  {
    sessionUpdate: "agent_thought_chunk",
    messageId: "summary",
    content: { type: "text", text: "Reviewing the event boundaries." },
  },
  {
    sessionUpdate: "tool_call",
    toolCallId: "running",
    title: "Long check",
    kind: "execute",
    status: "in_progress",
    rawInput: { command: "pnpm test", cwd: "/workspace" },
  },
  {
    sessionUpdate: "tool_call",
    toolCallId: "empty",
    title: "Check types",
    kind: "execute",
    status: "completed",
    rawInput: {
      command: "pnpm typecheck > /tmp/typecheck.log 2>&1",
      cwd: "/workspace",
    },
    rawOutput: { exitCode: 0, output: null },
  },
  {
    sessionUpdate: "tool_call",
    toolCallId: "web",
    title: "Search",
    kind: "web_search",
    status: "completed",
    rawInput: {
      query: "",
      action: {
        type: "find_in_page",
        url: "https://example.com/docs",
        pattern: "API",
      },
    },
    rawOutput: {
      results: [
        {
          title: "Reference",
          url: "https://example.com/docs",
          snippet: "API reference found",
        },
      ],
    },
  },
  {
    sessionUpdate: "tool_call",
    toolCallId: "edit",
    title: "Editing files",
    kind: "edit",
    status: "completed",
    rawInput: {
      changes: [
        {
          path: "/workspace/a.ts",
          kind: { type: "update" },
          diff: "@@ -1 +1 @@\n-const beforeA = 1;\n+const afterA = 2;\n",
        },
        {
          path: "/workspace/b.ts",
          kind: { type: "update" },
          diff: "@@ -1 +1 @@\n-const beforeB = 1;\n+const afterB = 2;\n",
        },
      ],
    },
  },
  {
    sessionUpdate: "tool_call",
    toolCallId: "unknown",
    title: "Future tool",
    kind: "other",
    status: "completed",
    rawInput: { action: "Inspect" },
    rawOutput: { detail: "Captured future result" },
  },
  {
    sessionUpdate: "tool_call",
    toolCallId: "failed",
    title: "Failed check",
    kind: "execute",
    status: "failed",
    rawInput: { command: "pnpm verify" },
    rawOutput: { exitCode: 1, output: "Verification failed" },
  },
  {
    sessionUpdate: "tool_call",
    toolCallId: "worker",
    title: "Worker result",
    kind: "subagent",
    status: "completed",
    rawInput: { tool: "spawnAgent", receiverThreadIds: ["child"] },
    rawOutput: {
      child: { status: "completed", message: "Worker completed its audit" },
    },
  },
];
const ctx: RendererContext = {
  isStreaming: true,
  lastMessageId: null,
  activeTurnStartedAt: 1,
  editBaselines: new Map(),
  pendingPermission: null,
  pendingQuestionToolCallIds: new Set(),
  chatId: null,
  setMode: null,
  subagentChildren: new Map(),
  respondToQuestion: () => {},
  respondToPermission: () => {},
  retrySafetyReview: async () => {},
  recordPolicy: () => {},
  editAndResubmit: () => {},
};
const request: QuestionRequest = {
  sessionId: "fixture",
  questionId: "optional",
  nativeRequestId: "native-optional",
  blocking: false,
  source: "native_dialog",
  questions: [
    {
      id: "format",
      prompt: "Choose a report format",
      options: [
        { id: "json", label: "JSON" },
        { id: "csv", label: "CSV" },
      ],
      defaultOptionIds: ["json"],
      allowOther: true,
    },
  ],
};

function Harness() {
  const [events, setEvents] = useState(() =>
    initial.reduce(
      (messages, update) =>
        applyUpdate(messages, { sessionId: "fixture", update }),
      [] as AgentMessage[],
    ),
  );
  const [live, setLive] = useState(true);
  const [answer, setAnswer] = useState<QuestionResponse | null>(null);
  const [active, setActive] = useState(true);
  const complete = () => {
    setEvents((previous) =>
      [
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "running",
          status: "completed",
          rawOutput: { exitCode: 0, output: "All checks passed" },
        },
        {
          sessionUpdate: "agent_message_chunk",
          messageId: "final",
          phase: "final_answer",
          content: { type: "text", text: "The final answer stays visible." },
        },
        {
          sessionUpdate: "tool_call",
          toolCallId: "late",
          title: "Background agent completed",
          status: "completed",
        },
      ].reduce(
        (messages, update) =>
          applyUpdate(messages, {
            sessionId: "fixture",
            update: update as SessionUpdate,
          }),
        previous,
      ),
    );
    setLive(false);
  };
  return (
    <TooltipProvider delayDuration={100}>
      <main className="bg-bg1 text-fg1 min-h-screen space-y-4 p-6">
        <div className="flex gap-2">
          <Button onClick={complete}>Complete turn</Button>
          <Button onClick={() => setActive(!active)}>Toggle active</Button>
        </div>
        <div id="codex-transcript">
          <TurnEventList
            events={events}
            isActive
            isStreaming={live}
            showActivity={false}
            ctx={{ ...ctx, isStreaming: live, attachmentImagesActive: active }}
          />
        </div>
        <div
          id="optional-question"
          {...(!active ? { inert: "" } : {})}
          aria-hidden={!active || undefined}
        >
          {!answer && <QuestionCard request={request} onRespond={setAnswer} />}
        </div>
        <Textarea aria-label="Composer" placeholder="Continue working" />
        <output id="question-response">{JSON.stringify(answer)}</output>
      </main>
    </TooltipProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Harness />);
