// ──────────────────────────────────────────────────────────
// QuestionRecordCard — READ-ONLY transcript record of an ask
// ──────────────────────────────────────────────────────────
//
// Claude AskUserQuestion (and future ask-user tools) still emit a tool_call
// into the timeline. This card is the READ-ONLY record of it, with three
// states:
//
//   • AWAITING RESPONSE — the question is still queued (matched through
//     nativeToolCallId / toolCallId against ctx.pendingQuestionToolCallIds).
//     A plain row, NOT expandable: the only interactive surface is the
//     composer-slot card, and previewing the questions here would duplicate
//     it.
//   • ANSWERED — the user submitted. Expandable; the body pairs each question
//     with the user's answer (options are not re-listed).
//   • SKIPPED — dismissed or timed out; the agent proceeded with its default.
//     Expandable; the body shows the questions + their options so the record
//     of what was asked survives, with no phantom answer.
//
// Rendered ON TOP OF EventRow (2026-07-04 consistency pass): same 12px icon
// cell with the hover +/- swap, same 14px label tier, same expanded-detail
// container (`bg-bg2/60` rounded box) as every other tool row — the question
// record must not read as a different surface.
//
// The INTERACTIVE surface is separate: a composer-slot <QuestionCard>
// (apps/desktop/src/renderer/features/agent/question-card.tsx) driven by the
// blocking QuestionRequest.
// ──────────────────────────────────────────────────────────

import { memo, useMemo } from "react";
import { CircleCheck, Clock, MessageSquare, SkipForward } from "lucide-react";

import type { AgentToolMessage } from "../use-agent-session";
import type { Renderer } from "./types";
import { readQuestionStamp } from "../sessions-store";
import { EventRow, type EventMeta } from "./event-row";

interface ParsedOption {
  label: string;
  description?: string;
}

interface ParsedQuestion {
  question: string;
  options: ParsedOption[];
}

/** The status chip next to the "User input" label — same recipe as the
 *  composer-card chip (mono, uppercase, bordered). */
function StatusChip({
  icon,
  children,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <span className="border-border1 text-fg2 flex shrink-0 items-center gap-1 rounded-sm border px-1.5 py-0.5 font-mono text-xxs tracking-wide uppercase">
      {icon}
      {children}
    </span>
  );
}

export const QuestionRecordCard: Renderer<AgentToolMessage> = memo(
  function QuestionRecordCard({ message, ctx }) {
    const questions = useMemo(
      () => parseQuestions(message.rawInput),
      [message.rawInput],
    );

    // Durable resolution record: the answer/skip path stamps rawOutput (see
    // stampQuestionAnswer). Null while awaiting / for legacy records.
    const stamp = readQuestionStamp(message.rawOutput);

    // Still queued → the composer card owns the interaction; this row is a
    // status line only, and deliberately NOT expandable. The pending set holds
    // the VENDOR's id (QuestionRequest.toolCallId), which matches this row's
    // nativeToolCallId; toolCallId is checked too for adapters where the two
    // are the same id.
    const awaiting =
      !stamp &&
      ((!!message.toolCallId &&
        ctx.pendingQuestionToolCallIds.has(message.toolCallId)) ||
        (!!message.nativeToolCallId &&
          ctx.pendingQuestionToolCallIds.has(message.nativeToolCallId)));

    const meta: EventMeta = {
      Icon: MessageSquare,
      label: "User input",
      expandable: !awaiting,
    };

    const chip = awaiting ? (
      <StatusChip icon={<Clock className="size-2.5" aria-hidden="true" />}>
        Awaiting response
      </StatusChip>
    ) : stamp?.outcome === "answered" ? (
      <StatusChip icon={<CircleCheck className="size-2.5" aria-hidden="true" />}>
        Answered
      </StatusChip>
    ) : stamp?.outcome === "skipped" ? (
      <StatusChip icon={<SkipForward className="size-2.5" aria-hidden="true" />}>
        Skipped
      </StatusChip>
    ) : null;

    // The detail body — same container recipe as the other tool rows'
    // expanded views (Bash output / raw input): rounded, bg-bg2/60, 14px.
    const detail = awaiting ? undefined : (
      <div className="flex flex-col gap-3 rounded-md bg-bg2/60 p-2.5 text-sm leading-relaxed">
        {stamp?.outcome === "answered" ? (
          // Question ↔ answer pairs only — no scope tags, no option list.
          (stamp.answers && stamp.answers.length > 0
            ? stamp.answers
            : questions.map((q) => ({ prompt: q.question, value: "" }))
          ).map((a, i) => (
            <div key={i} className="flex flex-col gap-0.5">
              <div className="text-fg1">{a.prompt}</div>
              {a.value ? (
                <div className="text-fg2">
                  <span className="text-fg2/70">Answered: </span>
                  {a.value}
                </div>
              ) : null}
            </div>
          ))
        ) : questions.length === 0 ? (
          <div className="text-fg2 text-xs">
            The agent asked a question here.
          </div>
        ) : (
          // Skipped (or a legacy un-stamped record): what was asked —
          // questions + options, no answers.
          questions.map((q, i) => (
            <div key={i} className="flex flex-col gap-1">
              <div className="text-fg1">{q.question}</div>
              {q.options.length > 0 ? (
                <ul className="flex flex-col gap-0.5 pl-1">
                  {q.options.map((o, oi) => (
                    <li key={oi} className="text-fg2 text-xs">
                      <span className="text-fg2/70 mr-1.5 font-mono">
                        {oi + 1}
                      </span>
                      {o.label}
                      {o.description ? (
                        <span className="text-fg2/70"> — {o.description}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ))
        )}
      </div>
    );

    return (
      <EventRow
        message={message}
        ctx={ctx}
        meta={meta}
        detail={detail}
        trailingNode={chip}
        // The tool status is "failed" for Claude (the answer rides a deny
        // tool_result — a delivery mechanism, not an error); never tint the
        // question record red.
        toneOverride="ok"
      />
    );
  },
);

function parseQuestions(input: unknown): ParsedQuestion[] {
  if (!isObj(input)) return [];
  const arr = Array.isArray(input.questions) ? input.questions : null;
  if (!arr) return [];
  const out: ParsedQuestion[] = [];
  for (const q of arr) {
    if (!isObj(q)) continue;
    const text = typeof q.question === "string" ? q.question : null;
    if (!text) continue;
    const options: ParsedOption[] = Array.isArray(q.options)
      ? q.options.flatMap((o: unknown) => {
          if (typeof o === "string") return [{ label: o }];
          if (isObj(o) && typeof o.label === "string") {
            return [
              {
                label: o.label,
                description:
                  typeof o.description === "string" ? o.description : undefined,
              },
            ];
          }
          return [];
        })
      : [];
    out.push({ question: text, options });
  }
  return out;
}

function isObj(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}
