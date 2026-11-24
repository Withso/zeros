// Synthetic turns exercise the production working groups, in-between
// messages and the live loader line, live and settled, with the setting on
// and off. No provider IO.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { AgentMessage, AgentToolMessage } from "@zeros/protocol/agent-messages";
import { TurnEventList } from "../features/agent/turn-event-list";
import { TurnFooter } from "../features/agent/turn-footer";
import { ActionsCtx } from "../features/agent/sessions-context";
import type { RendererContext } from "../features/agent/renderers/types";
import { setShowInBetweenMessages, useShowInBetweenMessages } from "../features/settings/in-between-messages";
import { useStickyBottom } from "../features/agent/use-sticky-bottom";
import { Button } from "../shared/ui/primitives/button";
import { TooltipProvider } from "../shared/ui/primitives/tooltip";

const NOW = Date.now();
const ago = (ms: number) => NOW - ms;

type Spec = { id: string; t: "read" | "grep" | "bash" | "edit" | "agent"; d: string; at: number; end?: number; status?: AgentToolMessage["status"] };

function tool({ id, t, d, at, end, status = "completed" }: Spec): AgentToolMessage {
  const settled = status === "completed" || status === "failed";
  const base = { kind: "tool" as const, id, toolCallId: id, status, createdAt: at, updatedAt: end ?? at, ...(settled ? { settledAt: end ?? at } : {}) };
  switch (t) {
    case "read": return { ...base, title: "Read", toolKind: "read", rawInput: { path: d }, ...(settled ? { rawOutput: [{ type: "text", text: "source" }] } : {}) };
    case "grep": return { ...base, title: "Grep", toolKind: "search", rawInput: { pattern: d }, ...(settled ? { rawOutput: "src/a.ts" } : {}) };
    case "edit": return { ...base, title: "Edit", toolKind: "edit", rawInput: { file_path: d, old_string: "a", new_string: "b" } };
    case "agent": return { ...base, title: "Agent", toolKind: "subagent", rawInput: { description: d, subagent_type: "Explore" }, ...(settled ? { rawOutput: "Report" } : {}) };
    default: return { ...base, title: "Bash", toolKind: "execute", rawInput: { command: d }, ...(settled ? { rawOutput: { exitCode: status === "failed" ? 1 : 0, output: "done" } } : {}) };
  }
}
const say = (id: string, text: string, at: number, phase?: "commentary" | "final_answer"): AgentMessage =>
  ({ kind: "text", id, role: "agent", text, createdAt: at, updatedAt: at, ...(phase ? { phase } : {}) });

const think = (id: string, text: string, at: number, end = at): AgentMessage =>
  ({ kind: "text", id, role: "thought", text, createdAt: at, updatedAt: end });

const M1 = "The partition already separates answers from work. Next I’ll add the in-between message boundary, then rerun the adjacent suites.";
const M2 = "Typecheck passes. Running the adjacent suites before I report back.";
const ANSWER = "In-between messages now sit between working groups while the agent streams, and a setting decides whether they stay there once the turn is done.";

const liveRead = tool({ id: "live-one-read", t: "read", d: "package.json", at: ago(2_000), status: "in_progress" });
const liveGroup = [
  tool({ id: "live-g-read", t: "read", d: "apps/desktop/src/renderer/features/agent/turn-partition.ts", at: ago(9_000), end: ago(8_000) }),
  tool({ id: "live-g-grep", t: "grep", d: "partitionTurnSequence", at: ago(7_000), end: ago(6_000) }),
  tool({ id: "live-g-bash", t: "bash", d: "pnpm vitest run turn-partition", at: ago(5_000), status: "in_progress" }),
];
const between = [
  tool({ id: "mid-read", t: "read", d: "event-stripe.tsx", at: ago(60_000), end: ago(50_000) }),
  tool({ id: "mid-grep", t: "grep", d: "WORKING_FEED_GAP", at: ago(48_000), end: ago(30_000) }),
  tool({ id: "mid-bash", t: "bash", d: "pnpm typecheck", at: ago(28_000), end: ago(12_000) }),
  say("mid-m1", M1, ago(10_000)),
];
const permission = [
  tool({ id: "perm-read", t: "read", d: "package.json", at: ago(40_000), end: ago(38_000) }),
  tool({ id: "perm-edit", t: "edit", d: "src/turn-partition.ts", at: ago(30_000), end: ago(29_000) }),
  tool({ id: "perm-bash", t: "bash", d: "git push origin feature/working-groups", at: ago(5_000), status: "pending" }),
];
const done: AgentMessage[] = [
  tool({ id: "done-read", t: "read", d: "turn-partition.ts", at: 1_000, end: 4_000 }),
  tool({ id: "done-grep", t: "grep", d: "partitionTurnSequence", at: 5_000, end: 9_000 }),
  tool({ id: "done-read-2", t: "read", d: "event-stripe.tsx", at: 10_000, end: 20_000 }),
  tool({ id: "done-bash", t: "bash", d: "pnpm vitest run turn-partition", at: 21_000, end: 49_000 }),
  say("done-m1", M1, 50_000),
  tool({ id: "done-edit", t: "edit", d: "turn-partition.ts", at: 60_000, end: 70_000 }),
  tool({ id: "done-agent", t: "agent", d: "Review partition edge cases", at: 71_000, end: 150_000 }),
  tool({ id: "done-bash-2", t: "bash", d: "pnpm typecheck", at: 151_000, end: 190_000, status: "failed" }),
  say("done-m2", M2, 200_000),
  tool({ id: "done-bash-3", t: "bash", d: "pnpm vitest run features/agent", at: 210_000, end: 300_000 }),
  say("done-answer", ANSWER, 306_000),
];

// Thinking counts as a work row: Thinking, Bash, Thinking is one group.
const doneThinking: AgentMessage[] = [
  think("dt-think-1", "The header should count thinking rows as work, so a lone Bash between two thoughts reads as one group.", 1_000, 4_000),
  tool({ id: "dt-bash", t: "bash", d: "pnpm vitest run working-groups", at: 5_000, end: 14_000 }),
  think("dt-think-2", "Tests pass. Next I check the loader line.", 15_000, 18_000),
  say("dt-answer", "Thinking rows now count toward a working group.", 19_000),
];
const liveThinking: AgentMessage[] = [
  tool({ id: "lt-bash", t: "bash", d: "pnpm vitest run working-groups", at: ago(9_000), end: ago(4_000) }),
  // A streaming thought shows its description once its opening sentence is complete.
  think("lt-think", "Comparing the loader line subject with the row label. A streaming thought keeps its description", ago(3_000)),
];
const liveThought = [think("lo-think", "Reading the partition rules before touching the header. Then", ago(2_000))];

const SCRIPT: AgentMessage[][] = [
  [],
  [tool({ id: "s-read", t: "read", d: "package.json", at: ago(4_000), status: "in_progress" })],
  [tool({ id: "s-read", t: "read", d: "package.json", at: ago(4_000), end: ago(3_000) }),
    tool({ id: "s-grep", t: "grep", d: "partitionTurnSequence", at: ago(3_000), status: "in_progress" })],
  [tool({ id: "s-read", t: "read", d: "package.json", at: ago(4_000), end: ago(3_000) }),
    tool({ id: "s-grep", t: "grep", d: "partitionTurnSequence", at: ago(3_000), end: ago(2_000) }),
    tool({ id: "s-bash", t: "bash", d: "pnpm vitest run features/agent", at: ago(2_000), status: "in_progress" })],
];

const context: RendererContext = {
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

function Frame({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <figure id={id} data-frame="" className="border-border2 bg-bg1 m-0 flex w-[680px] flex-col gap-3 rounded-lg border p-5">
      <figcaption className="text-fg3 text-3xxs">{title}</figcaption>
      <div className="flex w-[640px] flex-col">{children}</div>
    </figure>
  );
}

function Turn({ id, events, live, permissionFor }: { id: string; events: AgentMessage[]; live: boolean; permissionFor?: string }) {
  const ctx = useMemo<RendererContext>(() => ({
    ...context,
    chatId: `working-groups-${id}`,
    isStreaming: live,
    pendingPermission: permissionFor ? { request: { toolCall: { toolCallId: permissionFor } } } as RendererContext["pendingPermission"] : null,
  }), [id, live, permissionFor]);
  return <TurnEventList events={events} isActive isStreaming={live} activityStartedAt={ago(65_000)} ctx={ctx} />;
}

/** A turn stopped by the user, with its real footer (the STOPPED BY USER
 * badge), for the air between a hovered last row and the badge. */
function StoppedTurn({ id, events }: { id: string; events: AgentMessage[] }) {
  const ctx = useMemo<RendererContext>(() => ({ ...context, chatId: `working-groups-${id}`, isStreaming: false }), [id]);
  return (
    <div data-stopped-turn={id}>
      <ActionsCtx.Provider value={{} as never}><TurnEventList events={events} isActive isStreaming={false} activityStartedAt={ago(65_000)} ctx={ctx}
        footer={<TurnFooter chatId={`working-groups-${id}`} turnId={`stopped-${id}`} threadTailKey={`stopped-${id}`}
          events={events} startedAt={ago(65_000)} live={false} readOnly fallbackStopReason="cancelled" />} /></ActionsCtx.Provider>
    </div>
  );
}

function Script({ id }: { id: string }) {
  const [step, setStep] = useState(1);
  const [message, setMessage] = useState(false);
  const [finished, setFinished] = useState(false);
  const events = useMemo(() => [
    ...SCRIPT[step],
    ...(message ? [say("s-m1", M1, ago(1_000))] : []),
  ], [step, message]);
  return (
    <>
      <div className="flex gap-2">
        <Button size="sm" variant="secondary" onClick={() => setStep((value) => Math.min(SCRIPT.length - 1, value + 1))}>Next call</Button>
        <Button size="sm" variant="secondary" onClick={() => setMessage(true)}>Send message</Button>
        <Button size="sm" variant="secondary" onClick={() => setFinished(true)}>Finish turn</Button>
      </div>
      <Turn id={id} events={events} live={!finished} />
    </>
  );
}

/** A call whose input is still streaming (a provider's provisional record:
 * "Editing file", no arguments) shows once its description is known, never
 * by its name alone; meanwhile the line keeps the previous call briefly,
 * then its timer. */
type InputShape = "edit" | "bash" | "agent";
const PROVISIONAL_INPUT: Record<InputShape, { title: string; toolKind: AgentToolMessage["toolKind"]; done: { title: string; rawInput: Record<string, string> } }> = {
  edit: { title: "Editing file", toolKind: "edit", done: { title: "Editing event-stripe.tsx",
    rawInput: { file_path: "apps/desktop/src/renderer/features/agent/renderers/event-stripe.tsx", old_string: "a", new_string: "b" } } },
  bash: { title: "Running shell command", toolKind: "execute", done: { title: "Running pnpm vitest run working-groups",
    rawInput: { command: "pnpm vitest run working-groups", description: "Run the working-group tests" } } },
  agent: { title: "Agent", toolKind: "subagent", done: { title: "Agent",
    rawInput: { description: "Audit the loader line", prompt: "Check every frame of the loader line." } } },
};
function InputStream() {
  const [events, setEvents] = useState<AgentMessage[]>([]);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const later = (ms: number, run: () => void) => { timers.current.push(window.setTimeout(run, ms)); };
  /** `completeAfter`: when its input completes, or null for never. */
  const start = (shape: InputShape, completeAfter: number | null) => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    const base = Date.now();
    const read = tool({ id: "in-read", t: "read", d: "turn-partition.ts", at: base - 9_000, end: base - 8_000 });
    const grep = (status: AgentToolMessage["status"]) => tool({ id: "in-grep", t: "grep", d: "partitionTurnSequence", at: base - 6_000, end: base + 300, status });
    setEvents([read, grep("in_progress")]);
    later(300, () => {
      const at = Date.now();
      const spec = PROVISIONAL_INPUT[shape];
      const provisional: AgentToolMessage = { kind: "tool", id: `in-${shape}`, toolCallId: `in-${shape}`, title: spec.title,
        toolKind: spec.toolKind, status: "in_progress", rawInput: {}, createdAt: at, updatedAt: at };
      setEvents([read, grep("completed"), provisional]);
      if (completeAfter !== null) later(completeAfter, () => setEvents([read, grep("completed"),
        { ...provisional, ...spec.done, updatedAt: Date.now() }]));
    });
  };
  return (
    <>
      <div className="flex flex-wrap gap-2" data-input-controls="">
        <Button size="sm" variant="secondary" onClick={() => start("edit", 700)}>Stream an edit&apos;s input</Button>
        <Button size="sm" variant="secondary" onClick={() => start("bash", null)}>Start a call whose input never completes</Button>
        <Button size="sm" variant="secondary" onClick={() => start("edit", 5_000)}>Stream an Edit slowly</Button>
        <Button size="sm" variant="secondary" onClick={() => start("bash", 5_000)}>Stream a Bash command slowly</Button>
        <Button size="sm" variant="secondary" onClick={() => start("agent", 5_000)}>Stream an Agent prompt slowly</Button>
      </div>
      <Turn id="input" events={events} live />
    </>
  );
}

/** Calls that arrive faster than the loader line's dwell: the middle one is
 * skipped and the line goes straight to the newest. */
function Burst() {
  const [count, setCount] = useState(0);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const events = useMemo(() => [
    tool({ id: "b-read", t: "read", d: "package.json", at: ago(60_000), status: count ? "completed" : "in_progress", end: ago(59_000) }),
    ...["burst-one.ts", "burst-two.ts", "burst-three.ts"].slice(0, count).map((file, index) =>
      tool({ id: `b-${index}`, t: "read", d: file, at: ago(30_000 - index), status: index === count - 1 ? "in_progress" : "completed", end: ago(29_000) })),
  ], [count]);
  return (
    <>
      <div className="flex gap-2">
        <Button size="sm" variant="secondary" onClick={() => {
          setCount(1);
          timers.current = [120, 240].map((delay, index) => window.setTimeout(() => setCount(index + 2), delay));
        }}>Three quick calls</Button>
      </div>
      <Turn id="burst" events={events} live />
    </>
  );
}

// ── The live tail as one sequence ─────────────────────────
// timer → call → group → next call → message streaming over several lines →
// timer → call → group → answer → end, at real speed, plus each transition
// on its own. The same chain also plays in a pinned and an unpinned scroller.

const CHAIN_MESSAGE = "The partition already separates answers from work, so this change is smaller than it looks. " +
  "I'll add one boundary for in-between messages and leave every other event with the tool calls, then move the timer " +
  "onto the group header so each group counts its own time and the footer keeps the total for the whole turn.";
const CHAIN_SHORT = "Typecheck passes; next I\u2019ll update the group header.";
const CHAIN_ANSWER = "In-between messages now sit between working groups while the agent streams, and the loader line glides with them.";

type ChainStep = "empty" | "a" | "ab" | "abc" | "message" | "d" | "de" | "de+1" | "de+2" | "de+3" | "answer" | "end" | "x" | "x-message";
const TRANSITIONS: Record<string, [ChainStep, ChainStep]> = {
  "1 Timer to call": ["empty", "a"],
  "2 Call to group": ["a", "ab"],
  "3 Next call": ["ab", "abc"],
  "4 Group to message": ["abc", "message"],
  "5 Lone call to message": ["x", "x-message"],
  "6 Message to call": ["message", "d"],
  "7 Turn ends": ["answer", "end"],
  // An answer still revealing when the turn ends: by the agent, or by Stop.
  "8 Answer ends": ["de", "end"],
  "9 Answer stopped": ["de", "end"],
  // A live turn with an older closed group and a live group, for reader toggles.
  "Live: two groups": ["de", "de"],
  // The reader opens the live group; three calls then arrive inside it.
  "Open group: three calls arrive": ["de", "de"],
  // An in-between message streams (held) after a live group, the next call
  // starts (the message appears), then a second call forms a new group.
  "10 Between: commentary, 3 lines": ["abc", "de"],
  "11 Between: commentary, 1 line": ["abc", "de"],
  "12 Between: phase-less, 3 lines": ["abc", "de"],
  "13 Between: phase-less, 1 line": ["abc", "de"],
};
type Between = { full: string; phase?: "commentary" };
const BETWEEN: Record<string, Between> = {
  "10 Between: commentary, 3 lines": { full: CHAIN_MESSAGE, phase: "commentary" },
  "11 Between: commentary, 1 line": { full: CHAIN_SHORT, phase: "commentary" },
  "12 Between: phase-less, 3 lines": { full: CHAIN_MESSAGE },
  "13 Between: phase-less, 1 line": { full: CHAIN_SHORT },
};
const CHAIN_ORDER: ChainStep[] = ["empty", "a", "ab", "abc", "message", "d", "de", "answer", "end"];

function chainEvents(step: ChainStep, base: number, text: string, answerAt?: number, between?: Between): AgentMessage[] {
  const call = (id: string, t: Spec["t"], d: string, index: number, running: boolean) =>
    tool({ id: `chain-${id}`, t, d, at: base + index * 1_000, end: base + index * 1_000 + 800, status: running ? "in_progress" : "completed" });
  const say2 = (id: string, value: string, index: number, phase?: "commentary" | "final_answer") => say(`chain-${id}`, value, base + index * 1_000, phase);
  const at = CHAIN_ORDER.indexOf(step);
  const upTo = (target: ChainStep) => at >= CHAIN_ORDER.indexOf(target);
  if (step === "x") return [call("x", "read", "package.json", 0, true)];
  // More calls arriving in the live group (for the reader-opened group).
  if (step.startsWith("de+")) {
    const extra = Number(step.slice(3));
    return [...chainEvents("de", base, text).map((event) => event.kind === "tool" && event.id === "chain-e"
      ? { ...event, status: "completed" as const, settledAt: event.createdAt + 800 } : event),
      ...["f", "g", "h"].slice(0, extra).map((id, index) => call(id, "grep", `pattern-${id}`, 6 + index, index === extra - 1))];
  }
  if (step === "x-message") return [call("x", "read", "package.json", 0, false), say2("x-m", text, 1, "commentary")];
  const events: AgentMessage[] = [];
  if (upTo("a")) events.push(call("a", "read", "apps/desktop/src/renderer/features/agent/turn-partition.ts", 0, step === "a"));
  if (upTo("ab")) events.push(call("b", "grep", "partitionTurnSequence", 1, step === "ab"));
  if (upTo("abc")) events.push(call("c", "bash", "pnpm vitest run working-groups", 2, step === "abc"));
  if (upTo("message")) events.push(between
    ? say2("m", step === "message" ? text : between.full, 3, between.phase)
    : say2("m", step === "message" ? text : CHAIN_MESSAGE, 3, "commentary"));
  if (upTo("d")) events.push(call("d", "edit", "event-stripe.tsx", 4, step === "d"));
  if (upTo("de")) events.push(call("e", "bash", "pnpm typecheck", 5, step === "de"));
  if (upTo("answer")) events.push(answerAt === undefined
    ? say2("answer", step === "answer" ? text : CHAIN_ANSWER, 6, "final_answer")
    : say("chain-answer", step === "answer" ? text : CHAIN_ANSWER, answerAt, "final_answer"));
  return events;
}

function Chain({ id, wrap, onChange, onReset, extra }: {
  id: string;
  extra?: ReactNode;
  wrap?: (turn: ReactNode) => ReactNode;
  onChange?: () => void;
  /** After a transition's before state is set: restore the reading position. */
  onReset?: () => void;
}) {
  const [state, setState] = useState<{ step: ChainStep; text: string; answerAt?: number; stopped?: boolean; between?: Between }>({ step: "empty", text: "" });
  const [base] = useState(() => Date.now());
  const timers = useRef<number[]>([]);
  const clear = () => { timers.current.forEach(clearTimeout); timers.current = []; };
  useEffect(() => clear, []);
  // Same commit as the change, like the chat's own content dependency.
  useLayoutEffect(() => { onChange?.(); }, [state, onChange]);
  const later = (ms: number, run: () => void) => { timers.current.push(window.setTimeout(run, ms)); };
  // Messages stream at about 500 characters a second in bursty deltas.
  const stream = (step: ChainStep, full: string, from: number) => {
    for (let length = 0, at = from; length < full.length; at += 50) {
      length = Math.min(full.length, length + 18 + ((length * 7) % 13));
      const text = full.slice(0, length);
      later(at, () => setState({ step, text }));
    }
    return from + Math.ceil(full.length / 25) * 50;
  };
  const streamWith = (full: string, from: number, apply: (text: string) => void) => {
    let at = from;
    for (let length = 0; length < full.length; at += 50) {
      length = Math.min(full.length, length + 18 + ((length * 7) % 13));
      const text = full.slice(0, length);
      later(at, () => apply(text));
    }
    return at;
  };
  const go = (step: ChainStep, at: number) => {
    const full = step === "message" || step === "x-message" ? CHAIN_MESSAGE : step === "answer" ? CHAIN_ANSWER : "";
    if (full) return stream(step, full, at) + 400;
    later(at, () => setState({ step, text: "" }));
    return at;
  };
  const play = () => {
    clear();
    setState({ step: "empty", text: "" });
    let at = 900;
    for (const step of CHAIN_ORDER.slice(1)) at = go(step, at) + (step === "end" ? 0 : 1_600);
  };
  const live = state.step !== "end";
  const events = useMemo(() => chainEvents(state.step, base, state.text, state.answerAt, state.between), [state, base]);
  const ctx = useMemo<RendererContext>(() => ({ ...context, chatId: `chain-${id}`, isStreaming: live }), [id, live]);
  const turn = (
    <div data-chain-turn="">
      <TurnEventList events={events} isActive isStreaming={live} activityStartedAt={base} ctx={ctx}
        endedNaturally={!live && !state.stopped}
        footer={live ? undefined : <div data-chain-footer="" className="text-fg3 flex h-7 items-center text-xs">Worked for 12s</div>} />
    </div>
  );
  return (
    <>
      <div className="flex flex-wrap gap-2" data-chain-controls="">
        <Button size="sm" variant="secondary" onClick={play}>Play chain</Button>
        {Object.entries(TRANSITIONS).map(([name, [before, after]]) => (
          <Button key={name} size="sm" variant="secondary" onClick={() => {
            clear();
            const full = before === "answer" ? CHAIN_ANSWER : before === "message" ? CHAIN_MESSAGE : "";
            setState({ step: before, text: full });
            if (onReset) later(80, onReset);
            const between = BETWEEN[name];
            if (between) {
              const end = streamWith(between.full, 300, (text) => setState({ step: "message", text, between }));
              later(end + 150, () => setState({ step: "d", text: between.full, between }));
              later(end + 1_050, () => setState({ step: "de", text: between.full, between }));
              return;
            }
            if (name === "8 Answer ends" || name === "9 Answer stopped") {
              // The answer streams in from its start (a fresh message); the
              // turn ends right after its last delta, mid-reveal.
              const answerAt = Date.now() + 300;
              const end = streamWith(CHAIN_ANSWER, 300, (text) => setState({ step: "answer", text, answerAt }));
              later(end + 60, () => setState({ step: "end", text: CHAIN_ANSWER, answerAt, stopped: name === "9 Answer stopped" }));
              return;
            }
            if (name === "Open group: three calls arrive") {
              for (const [index, step] of (["de+1", "de+2", "de+3"] as ChainStep[]).entries()) later(900 + index * 450, () => setState({ step, text: "" }));
              return;
            }
            go(after, 700);
          }}>{name}</Button>
        ))}
        {extra}
      </div>
      {wrap ? wrap(turn) : turn}
    </>
  );
}

const FILLER = Array.from({ length: 10 }, (_, index) => `Earlier conversation, paragraph ${index + 1}. The transcript above the live turn scrolls with the chat.`);

/** The chain inside a chat-like scroller: pinned follows the bottom like the
 * real transcript; unpinned is scrolled up with room below the turn. */
function ScrolledChain({ id, pinned }: { id: string; pinned: boolean }) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [revision, setRevision] = useState(0);
  const changed = useMemo(() => () => setRevision((value) => value + 1), []);
  const { jumpToBottom } = useStickyBottom(el, [revision], { initialAtBottom: pinned });
  const position = useMemo(() => () => {
    if (!el) return;
    if (pinned) jumpToBottom(false);
    // Read from above: earlier paragraphs fill the top of the view.
    else {
      const turn = (el.querySelector("[data-chain-turn]") as HTMLElement).getBoundingClientRect().top;
      el.scrollTop = Math.max(0, turn - el.getBoundingClientRect().top + el.scrollTop - 150);
    }
  }, [el, pinned, jumpToBottom]);
  useEffect(position, [position]);
  // Comparison only: "off" keeps the snap of the scroll follow (before stage 6).
  const [glide, setGlide] = useState(true);
  useEffect(() => {
    if (el) el.dataset.contentGlide = glide ? "on" : "off";
  }, [el, glide]);
  return (
    <Chain id={id} onChange={changed} onReset={position} extra={pinned ? (
      <Button size="sm" variant="secondary" onClick={() => setGlide((value) => !value)}>
        {glide ? "Content glide: on" : "Content glide: off"}
      </Button>
    ) : null} wrap={(turn) => (
      // Unpinned also turns the browser's scroll anchoring off, so layout moves
      // reach the screen (anchoring would otherwise often hold the tail still).
      <div ref={setEl} data-chain-scroller={pinned ? "pinned" : "unpinned"} className="border-border2 h-[260px] overflow-y-auto rounded-md border px-3"
        style={pinned ? undefined : { overflowAnchor: "none" }}>
        {/* One content child, like the chat: the scroll hook observes it. */}
        <div>
          {FILLER.map((text) => <p key={text} className="text-fg3 my-3 text-reading">{text}</p>)}
          {turn}
          {pinned ? null : <div className="h-[600px]" />}
        </div>
      </div>
    )} />
  );
}

function Harness() {
  const showInBetween = useShowInBetweenMessages();
  return (
    <TooltipProvider delayDuration={100}>
      <main data-Zeros-root="" className="bg-bg0 text-fg1 flex min-h-screen flex-wrap content-start gap-4 p-6">
        <div className="flex w-full items-center gap-3">
          <Button size="sm" variant="secondary" onClick={() => setShowInBetweenMessages(!showInBetween)}>
            {showInBetween ? "Turn the setting off" : "Turn the setting on"}
          </Button>
        </div>
        <Frame id="chain" title="The live tail, start to end"><Chain id="chain" /></Frame>
        <Frame id="chain-pinned" title="The live tail in a pinned scroller"><ScrolledChain id="pinned" pinned /></Frame>
        <Frame id="chain-unpinned" title="The live tail in a scroller read from above"><ScrolledChain id="unpinned" pinned={false} /></Frame>
        <Frame id="live-script" title="Live, scripted"><Script id="script" /></Frame>
        <Frame id="live-lone" title="Live, scripted: a lone call"><Script id="lone" /></Frame>
        <Frame id="live-reduced" title="Live, scripted: reduced motion"><Script id="reduced" /></Frame>
        <Frame id="live-one" title="Live: one call"><Turn id="one" events={[liveRead]} live /></Frame>
        <Frame id="live-group" title="Live: group"><Turn id="group" events={liveGroup} live /></Frame>
        <Frame id="live-between" title="Live: message between groups"><Turn id="between" events={between} live /></Frame>
        <Frame id="live-open" title="Live: group opened by you"><Turn id="open" events={liveGroup} live /></Frame>
        <Frame id="live-permission" title="Live: pending permission"><Turn id="permission" events={permission} live permissionFor="perm-bash" /></Frame>
        <Frame id="live-burst" title="Live: calls faster than the hand-off"><Burst /></Frame>
        <Frame id="input-stream" title="Live: a call's input streaming"><InputStream /></Frame>
        <Frame id="live-thinking" title="Live: Thinking on the loader line"><Turn id="thinking" events={liveThinking} live /></Frame>
        <Frame id="live-thought" title="Live: a lone thought"><Turn id="thought" events={liveThought} live /></Frame>
        <Frame id="done" title="Done"><Turn id="done" events={done} live={false} /></Frame>
        <Frame id="done-thinking" title="Done: Thinking, Bash, Thinking"><Turn id="done-thinking" events={doneThinking} live={false} /></Frame>
        <Frame id="done-open" title="Done: a group opened"><Turn id="done-open" events={done} live={false} /></Frame>
        <Frame id="done-prose" title="Done: commentary, then the answer (no calls)">
          <Turn id="done-prose" events={[say("prose-m", M2, 1_000, "commentary"), say("prose-answer", ANSWER, 4_000, "final_answer")]} live={false} />
        </Frame>
        <Frame id="stopped" title="Stopped by you: the badge under a group, a row, a message">
          <StoppedTurn id="group" events={liveGroup.map((event) => ({ ...event, status: "completed" as const, settledAt: event.createdAt }))} />
          <StoppedTurn id="row" events={[tool({ id: "stop-row", t: "read", d: "package.json", at: ago(9_000), end: ago(8_000) })]} />
          <StoppedTurn id="message" events={[...between.slice(0, 3), say("stop-m", M2, ago(5_000))]} />
        </Frame>
      </main>
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
