import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentMessage, AgentTextMessage } from "@zeros/protocol/agent-messages";
import { setShowInBetweenMessages } from "../features/settings/in-between-messages";
import { MessageView } from "../features/agent/renderers/message-view";
import type { RendererContext } from "../features/agent/renderers/types";
import { Button } from "../shared/ui/primitives/button";
import { TurnEventList } from "../features/agent/turn-event-list";

const initialText = "The initial paragraph is already visible.";
const suffix =
  " New assistant text arrives smoothly in a short burst, with a subtle fade at the advancing edge. Emoji stay intact: 👩🏽‍💻. ";
const textMessage = (id: string, text: string): AgentTextMessage => ({
  id,
  kind: "text",
  role: "agent",
  text,
  createdAt: 1,
});

const read = (id: string, path: string): AgentMessage => ({
  id, kind: "tool", toolCallId: id, title: "Read", toolKind: "read",
  rawInput: { path }, status: "completed", createdAt: 1, updatedAt: 2,
});

/** An in-between message that streams outside its working group and, once
 * the turn settles with the setting off, remounts inside the group. */
function SettleProbe({ ctx }: { ctx: RendererContext }) {
  const [text, setText] = useState("Checking the partition next.");
  const [live, setLive] = useState(true);
  const events = useMemo<AgentMessage[]>(() => [
    read("settle-a", "turn-partition.ts"),
    read("settle-b", "working-group.ts"),
    { ...textMessage("settle-between", text), phase: "commentary" },
  ], [text]);
  const context = useMemo(() => ({ ...ctx, chatId: "streaming-settle", isStreaming: live, lastMessageId: "settle-between" }), [ctx, live]);
  return (
    <div id="settle-probe" data-source={text} className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => setText((value) => value + suffix)}>Append in-between text</Button>
        <Button onClick={() => { setShowInBetweenMessages(false); setLive(false); }}>Settle with in-between messages folded</Button>
        <Button onClick={() => { setShowInBetweenMessages(true); setLive(true); setText("Checking the partition next."); }}>Reset settle probe</Button>
      </div>
      <TurnEventList isActive isStreaming={live} ctx={context} events={events} />
    </div>
  );
}

const LONG_PARAGRAPH = "The partition already separates answers from work, so this change is smaller than it looks. " +
  "I'll add one boundary for in-between messages and leave every other event with the tool calls, then move the timer " +
  "onto the group header so each group counts its own time, as [the docs](https://example.test/docs) describe. ";
/** A long reply: 5,000 (or 12,000) characters already shown, then 3,000 more
 * streamed. */
const longReply = (length: number) => {
  let text = "";
  for (let index = 0; text.length < length; index++)
    text += LONG_PARAGRAPH + (index % 3 === 2 ? "\n\n" : "");
  return text.slice(0, length);
};
const LONG = { small: [5_000, 8_000], large: [5_000, 8_000], longer: [12_000, 15_000], blocks: [0, 0], slices: [5_000, 6_500], huge: [29_000, 32_000] } as const;
/** An answer of three paragraphs with a list and a table, streamed from
 * its start. */
const BLOCKS = "The reveal now works block by block. Each paragraph, list item and table row appears once it is " +
  "complete, with a short fade in place, and nothing moves after it appears.\n\n" +
  "Here is what changed:\n\n- In-between messages appear whole, at once.\n" +
  "- Output units fade in one by one, never far behind the text.\n- A long paragraph releases its finished lines in steps.\n\n" +
  "| Case | What you see |\n| --- | --- |\n| Natural end | The rest fades in place |\n| Stop | Everything at once |\n" +
  "| Reduced motion | Text as it arrives |\n\n" +
  "The footer waits for the layout, not the fade, so Copy output always copies the whole answer.";
const seeded = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;

/** Streams a long reply with bursty deltas: `small` mimics token-sized
 * deltas, `large` the multi-line deltas a provider can batch. */
function LongStreamProbe({ ctx }: { ctx: RendererContext }) {
  const [length, setLength] = useState<number>(LONG.small[0]);
  const [mode, setMode] = useState<keyof typeof LONG | null>(null);
  // Each run is a new message (a restart is not a correction of the last),
  // and restarts the stream even in the same mode.
  const [run, setRun] = useState(0);
  const timer = useRef(0);
  useEffect(() => {
    if (!mode) return;
    const random = seeded(7);
    const [start, endLength] = LONG[mode];
    const end = mode === "blocks" ? BLOCKS.length : endLength;
    let current: number = start;
    const step = () => {
      // `slices`: a few characters every frame, like the old reveal-by-slicing.
      current = Math.min(end, current + (mode === "slices" ? 2 + Math.floor(random() * 5)
        : mode === "small" || mode === "blocks" || mode === "huge" ? 4 + Math.floor(random() * 40) : 120 + Math.floor(random() * 360)));
      setLength(current);
      if (current >= end) setMode(null);
      else timer.current = window.setTimeout(step, mode === "slices" ? 16 : mode === "small" || mode === "blocks" || mode === "huge" ? 20 + random() * 60 : 120 + random() * 280);
    };
    timer.current = window.setTimeout(step, 0);
    return () => clearTimeout(timer.current);
  }, [mode, run]);
  const [blocks, setBlocks] = useState(false);
  const [stopped, setStopped] = useState(false);
  // Comparison only: show text as it arrives (the model before the reveal).
  const [revealOff, setRevealOff] = useState(false);
  const message = useMemo<AgentTextMessage>(() => blocks
    ? { ...textMessage(`long-message-${run}`, BLOCKS.slice(0, length)), phase: "final_answer" }
    : textMessage(`long-message-${run}`, longReply(length)), [length, blocks, run]);
  const context = useMemo(() => ({ ...ctx, isStreaming: !stopped, lastMessageId: message.id }), [ctx, message.id, stopped]);
  const start = (next: keyof typeof LONG) => {
    setRun((value) => value + 1);
    setStopped(false);
    setBlocks(next === "blocks");
    setLength(LONG[next][0]);
    setMode(next);
  };
  return (
    <div id="long-stream-probe" data-length={length} data-source-length={message.text.length} data-streaming={mode ?? ""}
      data-text-reveal={revealOff ? "off" : undefined} className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => start("blocks")}>Stream an answer with a list and a table</Button>
        <Button onClick={() => { setStopped(true); setMode(null); }}>Stop the reply</Button>
        <Button onClick={() => setRevealOff((value) => !value)}>{revealOff ? "Reveal: off" : "Reveal: on"}</Button>
        <Button onClick={() => start("small")}>Stream long reply in small deltas</Button>
        <Button onClick={() => start("large")}>Stream long reply in large deltas</Button>
        <Button onClick={() => start("longer")}>Stream longer reply in large deltas</Button>
        <Button onClick={() => start("slices")}>Stream long reply in per-frame slices</Button>
        <Button onClick={() => start("huge")}>Stream a 32k reply in small deltas</Button>
      </div>
      <MessageView key={message.id} message={message} ctx={context} />
    </div>
  );
}

export function StreamingTextFixture({ ctx }: { ctx: RendererContext }) {
  const [text, setText] = useState(initialText);
  const [active, setActive] = useState(true);
  const [streaming, setStreaming] = useState(true);
  const [tail, setTail] = useState(true);
  const message = useMemo(() => textMessage("smooth-message", text), [text]);
  const context = useMemo(
    () => ({
      ...ctx,
      isStreaming: streaming,
      lastMessageId: tail ? message.id : "next-tool",
      attachmentImagesActive: active,
    }),
    [ctx, streaming, tail, message.id, active],
  );
  return (
    <section
      id="streaming-text-fixture"
      className="mx-auto w-full max-w-3xl space-y-4"
    >
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => setText((value) => value + suffix)}>
          Append assistant text
        </Button>
        <Button onClick={() => setText("Authoritative correction.")}>
          Correct assistant text
        </Button>
        <Button onClick={() => setStreaming(false)}>Stop assistant text</Button>
        <Button onClick={() => setTail(false)}>
          Advance assistant activity
        </Button>
        <Button onClick={() => setActive((value) => !value)}>
          Toggle text surface
        </Button>
        <Button
          onClick={() => {
            setText(initialText);
            setStreaming(true);
            setTail(true);
          }}
        >
          Reset assistant text
        </Button>
      </div>
      <div id="streaming-text-probe" data-source={text} data-active={active}>
        <MessageView message={message} ctx={context} />
      </div>
      <SettleProbe ctx={ctx} />
      <LongStreamProbe ctx={ctx} />
      <div id="multiple-report-probe">
        <TurnEventList
          isActive={false}
          isStreaming={false}
          ctx={ctx}
          events={[
            {
              id: "before-report",
              kind: "tool",
              toolCallId: "before-report",
              title: "Read",
              toolKind: "read",
              rawInput: { path: "first.ts" },
              status: "completed",
              createdAt: 1,
              updatedAt: 2,
            },
            {
              ...textMessage(
                "first-report",
                "The first confirmed report stays visible.",
              ),
              phase: "final_answer",
            },
            {
              id: "between-reports",
              kind: "tool",
              toolCallId: "between-reports",
              title: "Read",
              toolKind: "read",
              rawInput: { path: "second.ts" },
              status: "completed",
              createdAt: 3,
              updatedAt: 4,
            },
            {
              ...textMessage(
                "second-report",
                "The second confirmed report stays visible too.",
              ),
              phase: "final_answer",
            },
          ]}
        />
      </div>
    </section>
  );
}
