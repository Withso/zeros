// ──────────────────────────────────────────────────────────
// ModelSwitchRecordCard — §3.6 R2 · "Model switched · FALLBACK"
// ──────────────────────────────────────────────────────────
//
// The durable transcript record of a model fallback: the primary model was
// overloaded / unavailable (or refused), so the turn continued on the
// configured fallback model. Emitted by the Claude translator as a settled
// tool_call (kind="model_switch") wherever the swap happened — a fallback can
// fire mid-turn, so it lives inline in the working group like any other tool
// call. Never a toast (user spec 2026-07-13).
//
// Rendered ON TOP OF EventRow — the exact "User input · ANSWERED" recipe:
// 13px glyph + simple label + mono-uppercase StatusChip, expanding to a
// bg-bg2/60 detail panel that carries the description.
// ──────────────────────────────────────────────────────────

import { memo } from "react";
import { Repeat2 } from "lucide-react";

import type { AgentToolMessage } from "../use-agent-session";
import type { Renderer } from "./types";
import { displayNameForModelValue } from "../model-catalog";
import { EventRow, type EventMeta } from "./event-row";

interface SwitchInfo {
  fromModel: string | null;
  toModel: string | null;
  reason: "overloaded" | "refusal" | null;
}

function readSwitchInfo(input: unknown): SwitchInfo {
  const obj =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  return {
    fromModel: typeof obj.fromModel === "string" ? obj.fromModel : null,
    toModel: typeof obj.toModel === "string" ? obj.toModel : null,
    reason:
      obj.reason === "overloaded" || obj.reason === "refusal"
        ? obj.reason
        : null,
  };
}

export const ModelSwitchRecordCard: Renderer<AgentToolMessage> = memo(
  function ModelSwitchRecordCard({ message, ctx }) {
    const info = readSwitchInfo(message.rawInput);
    const from = info.fromModel
      ? displayNameForModelValue(null, info.fromModel)
      : null;
    const to = info.toModel
      ? displayNameForModelValue(null, info.toModel)
      : "a fallback model";

    const meta: EventMeta = {
      Icon: Repeat2,
      label: "Model switched",
      expandable: true,
    };

    const chip = (
      <span className="border-border1 text-fg2 flex shrink-0 items-center gap-1 rounded-sm border px-1.5 py-0.5 font-mono text-xxs tracking-wide uppercase">
        Fallback
      </span>
    );

    const detail = (
      <div className="bg-bg2/60 flex flex-col gap-1.5 rounded-md p-2.5 text-sm leading-relaxed">
        <span className="text-fg2">
          {info.reason === "refusal" ? (
            <>
              {from ? (
                <b className="text-fg1 font-semibold">{from}</b>
              ) : (
                "The primary model"
              )}{" "}
              couldn’t answer this request, so the turn was retried on{" "}
              <b className="text-fg1 font-semibold">{to}</b>.
            </>
          ) : (
            <>
              {from ? (
                <b className="text-fg1 font-semibold">{from}</b>
              ) : (
                "The primary model"
              )}{" "}
              was overloaded or unavailable, so the turn continued on{" "}
              <b className="text-fg1 font-semibold">{to}</b> and finished
              normally.
            </>
          )}
        </span>
        <span className="text-fg3 text-[11.5px]">
          {info.reason === "refusal" ? (
            <>The session continues on the fallback · no action needed</>
          ) : (
            <>
              Returns to {from ?? "the primary model"} on the next turn · no
              action needed
            </>
          )}
        </span>
      </div>
    );

    return (
      <EventRow
        message={message}
        ctx={ctx}
        meta={meta}
        detail={detail}
        trailingNode={chip}
        toneOverride="ok"
      />
    );
  },
);
