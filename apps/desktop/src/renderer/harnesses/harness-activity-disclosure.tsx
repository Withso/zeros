// Synthetic stopped/steered transcripts exercise the production disclosure
// tree, including a resident window whose opening prompt is still on disk.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  AgentMessage,
  AgentToolMessage,
} from "@zeros/protocol/agent-messages";
import { TurnContainer } from "../features/agent/turn-container";
import { TurnEventList } from "../features/agent/turn-event-list";
import {
  groupMessagesIntoTurns,
  isTailProviderTurnSegment,
  turnKey,
} from "../features/agent/turn-grouping";
import { stabilizeTurns } from "../features/agent/stable-turns";
import type { RendererContext } from "../features/agent/renderers/types";
import { Button } from "../shared/ui/primitives/button";
import { TooltipProvider } from "../shared/ui/primitives/tooltip";

const providers = ["Claude", "Codex", "Cursor"] as const;
const requestedProvider = new URLSearchParams(location.search).get("provider");
const provider =
  providers.find((value) => value === requestedProvider) ?? "Claude";

function tool(id: string): AgentToolMessage {
  const output = `Synthetic ${provider} result for ${id}`;
  return {
    id,
    kind: "tool",
    toolCallId: id,
    toolKind: "execute",
    title: "Bash",
    status: "completed",
    rawInput: { command: `echo ${id}` },
    rawOutput:
      provider === "Claude"
        ? output
        : provider === "Codex"
          ? { exitCode: 0, output }
          : { status: "success", value: { exitCode: 0, output } },
    createdAt: 1,
    updatedAt: 2,
    settledAt: 2,
  };
}

const text = (
  id: string,
  phase?: "commentary" | "final_answer",
): AgentMessage => ({
  id,
  kind: "text",
  role: "agent",
  text: `Synthetic narration ${id}`,
  phase,
  createdAt: 1,
});
const agent = (id: string): AgentToolMessage => ({
  ...tool(id),
  title: "Agent",
  toolKind: provider === "Cursor" ? "task" : "subagent",
  rawInput: {
    description: `Synthetic worker ${id}`,
    prompt: "Inspect the fixture",
  },
  rawOutput: "Synthetic worker finished",
});
const opening: AgentMessage = {
  id: "opening-prompt",
  kind: "text",
  role: "user",
  text: "Inspect the synthetic activity",
  createdAt: 1,
};
const largeWorking: AgentMessage[] = Array.from({ length: 257 }, (_, index) => [
  tool(`tool-${index}`),
  ...(index < 224 ? [text(`narration-${index}`, "commentary")] : []),
]).flat();
largeWorking.push(agent("worker-one"), agent("worker-two"));
const earlierPage = Array.from({ length: 100 }, (_, index) => [
  tool(`earlier-tool-${index}`),
  text(`earlier-narration-${index}`, "commentary"),
]).flat();
const tail: AgentMessage[] = [
  {
    id: "steer-prompt",
    kind: "text",
    role: "user",
    text: "Also inspect the second fixture",
    steeredTurnId: opening.id,
    createdAt: 2,
  },
  tool("after-steer-one"),
  text("first-report", "final_answer"),
  tool("after-steer-two"),
  {
    ...text("second-report", "final_answer"),
    text: Array.from(
      { length: 100 },
      (_, index) => `Synthetic final report paragraph ${index}`,
    ).join("\n\n"),
  } as AgentMessage,
];

const baseContext: RendererContext = {
  isStreaming: false,
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

function Transcript({
  chat,
  active,
  page,
  paginate,
  revision,
  live,
  onPage,
}: {
  chat: "a" | "b";
  active: boolean;
  page: number;
  paginate: boolean;
  revision: number;
  live: boolean;
  onPage: (page: number) => void;
}) {
  // Match AgentChat's commit-only turn stabilization. Each retained chat has
  // its own bounded snapshot; shared fixture IDs must not share disclosure.
  const committed = useRef<ReturnType<typeof groupMessagesIntoTurns>>([]);
  const turns = useMemo(
    () =>
      stabilizeTurns(
        committed.current,
        groupMessagesIntoTurns(
          [
            ...(page === 2 ? [opening] : []),
            ...(page > 0 ? earlierPage : []),
            ...largeWorking,
            ...tail,
          ].map((message) => (revision ? { ...message } : message)),
        ),
      ),
    [page, revision],
  );
  useLayoutEffect(() => {
    committed.current = turns;
  }, [turns]);
  const ctx = useMemo(
    () => ({
      ...baseContext,
      chatId: `activity-${provider}-${chat}`,
      attachmentImagesActive: active,
      isStreaming: live,
      subagentChildren: new Map([
        [
          "worker-one",
          [
            ...(page > 0 ? [tool("child-older")] : []),
            tool("child-tool"),
            text("child-report", "final_answer"),
          ],
        ],
      ]),
    }),
    [chat, active, live, page],
  );

  return (
    <div
      id={`activity-scroller-${chat}`}
      className={`absolute inset-0 overflow-y-auto ${active ? "" : "pointer-events-none invisible"}`}
      {...(!active ? { inert: "" } : {})}
      aria-hidden={!active || undefined}
      onScroll={(event) => {
        // Like AgentChat's near-top gate, scrolling prepends a page. The
        // second page deliberately restores the missing opening prompt.
        if (
          active &&
          paginate &&
          page === 0 &&
          event.currentTarget.scrollTop <= 600
        )
          onPage(1);
      }}
    >
      <div
        id={`activity-transcript-${chat}`}
        className="mx-auto flex max-w-[856px] flex-col gap-5 px-7 py-3"
      >
        {turns.map((turn, index) => (
          <TurnContainer
            key={turnKey(turn)}
            turn={turn}
            isActive={index === turns.length - 1}
          >
            {turn.userPrompt && <p>{turn.userPrompt.text}</p>}
            <TurnEventList
              events={turn.events}
              isActive={isTailProviderTurnSegment(turns, index)}
              isStreaming={live}
              showActivity={index === turns.length - 1}
              surfaceActive={active}
              ctx={ctx}
            />
          </TurnContainer>
        ))}
      </div>
    </div>
  );
}

function Harness() {
  const [page, setPage] = useState(0);
  const [paginate, setPaginate] = useState(false);
  const [chat, setChat] = useState<"a" | "b">("a");
  const [revision, setRevision] = useState(0);
  const [live, setLive] = useState({ a: false, b: false });
  const [active, setActive] = useState(true);

  return (
    <TooltipProvider>
      <main className="bg-bg1 text-fg1 flex h-screen flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span>{provider}</span>
          <Button onClick={() => setPaginate(true)}>Enable pagination</Button>
          <Button onClick={() => setPage(2)}>Load opening prompt</Button>
          <Button onClick={() => setRevision((value) => value + 1)}>
            Reload transcript
          </Button>
          <Button
            onClick={() => setChat((value) => (value === "a" ? "b" : "a"))}
          >
            Switch chat
          </Button>
          <Button
            onClick={() =>
              setLive((value) => ({ ...value, [chat]: !value[chat] }))
            }
          >
            {live[chat] ? "Stop turn" : "Resume turn"}
          </Button>
          <Button onClick={() => setActive((value) => !value)}>
            Toggle surface
          </Button>
          <output id="history-page">{page}</output>
          <output id="activity-chat">{chat}</output>
        </div>
        <div className="relative min-h-0 flex-1">
          {(["a", "b"] as const).map((owner) => (
            <Transcript
              key={owner}
              chat={owner}
              active={active && chat === owner}
              page={page}
              paginate={paginate}
              revision={revision}
              live={live[owner]}
              onPage={setPage}
            />
          ))}
        </div>
      </main>
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
