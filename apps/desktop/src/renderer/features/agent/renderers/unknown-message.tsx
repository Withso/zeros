// ──────────────────────────────────────────────────────────
// UnknownMessage — fallback for kinds we don't render yet
// ──────────────────────────────────────────────────────────
//
// The pre-refactor MessageView had a binary
// if/else (text → bubble, else → ToolCallCard) which silently
// dropped any future message kind. As we add tool-specific
// renderers (bash, edit, read, …) and engine events evolve,
// this card guarantees nothing falls through unseen.
//
// Uses EventRow rather than a system <Message> bubble, whose centered card
// chrome reads as
// misaligned next to the flat tool rows) to the SAME EventRow
// primitive every other tool uses. Collapsed: wrench icon +
// "Tool" label + a one-line description pill — deliberately NOT
// "Unrecognized event"; to the user it's just a tool call.
// Expanded: the raw JSON in the same bg3/40 code surface as the
// other tool detail bodies, so drift stays fully inspectable.
// ──────────────────────────────────────────────────────────

import { memo } from "react";
import { Wrench } from "lucide-react";
import type { AgentMessage } from "../use-agent-session";
import type { RendererContext } from "./types";
import { EventRow } from "./event-row";
import { HighlightedCode } from "./highlighted-code";

interface Props {
  message: AgentMessage;
  ctx: RendererContext;
}

/** Same cap as the other tool detail bodies (~8 lines of mono). */
const DETAIL_CLASS =
  "max-h-[200px] overflow-y-auto rounded-md bg-bg2/60 p-2 font-mono text-xs leading-relaxed text-fg1 [&_pre]:whitespace-pre-wrap [&_pre]:break-words";

export const UnknownMessage = memo(function UnknownMessage({
  message,
  ctx,
}: Props) {
  const preview = previewFor(message);
  return (
    <EventRow
      message={message}
      ctx={ctx}
      meta={{
        Icon: Wrench,
        label: "Tool",
        target: preview || undefined,
        trailing: undefined,
        expandable: true,
      }}
      detail={
        <HighlightedCode
          code={safeStringify(message)}
          lang="json"
          className={DETAIL_CLASS}
        />
      }
    />
  );
});

function previewFor(message: AgentMessage): string {
  // Best-effort one-liner. The whole point of this renderer is that we
  // don't trust the shape, so probe a few common fields rather than
  // type-narrowing. Whitespace-collapsed so the pill stays one line.
  const m = message as unknown as Record<string, unknown>;
  const raw =
    (typeof m.title === "string" && m.title) ||
    (typeof m.text === "string" && m.text) ||
    (typeof m.id === "string" && m.id) ||
    "";
  return raw.replace(/\s+/g, " ").trim().slice(0, 200);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
