// A delegated conversation is an unboxed nested feed. The group owns the
// disclosure; each child tool retains its own bounded detail card.
import { memo, useId, useMemo, useState } from "react";
import { Bot, ChevronDown, ChevronRight, MessageSquare } from "lucide-react";
import { partitionTurnSequence } from "../turn-partition";
import { MessageView } from "./message-view";
import type { AgentMessage, AgentToolMessage } from "../use-agent-session";
import type { Renderer } from "./types";
import { matchSubagent } from "./subagent";
import { EventStripe } from "./event-stripe";
import { renderDetail } from "./event-row-renderer";
import { renderMarkdown } from "../markdown";
import { displayNameForModelValue } from "../model-catalog";
import { cn } from "@/renderer/shared/ui/cn";
import { ZerosSpinner } from "@/renderer/shared/ui/loading";
import { asDisplayString, toolCompletionUnreported } from "./raw-output";
import { toolRecord } from "./native-tool-presentation";
import { toolPresentationReady } from "./tool-readiness";
import { ToolDetailSurface } from "./tool-detail-surface";

const NO_CHILDREN: AgentMessage[] = [];

export const SubagentCard: Renderer<AgentToolMessage> = memo(
  function SubagentCard({ message: tool, ctx }) {
    const input = toolRecord(tool.rawInput);
    const output = toolRecord(tool.rawOutput);
    const info = matchSubagent(tool);
    const headerText =
      readString(info?.description) ??
      readString(input.description) ??
      readString(input.prompt) ??
      readString(input.agentPath)?.split("/").at(-1) ??
      tool.title;
    const model = readString(output.resolvedModel) ?? readString(input.model);
    const modelLabel =
      model && model !== "inherit" ? agentModelLabel(model) : undefined;
    const prompt = readString(input.prompt) ?? readString(input.task);
    const children = ctx.subagentChildren.get(tool.toolCallId) ?? NO_CHILDREN;
    const result = agentReportText(tool);
    // Native child final output already appears in the nested conversation. A
    // tool-result copy of that same report is redundant, not another message.
    const resultInChildren = children.some(
      (child) =>
        child.kind === "text" &&
        child.role === "agent" &&
        child.text.trim() === result.trim(),
    );
    const promptHtml = useMemo(
      () => (prompt ? renderMarkdown(prompt) : ""),
      [prompt],
    );
    const resultHtml = useMemo(
      () => (result ? renderMarkdown(result) : ""),
      [result],
    );
    const unreported = toolCompletionUnreported(tool.rawOutput);
    const running =
      (tool.status === "pending" || tool.status === "in_progress") &&
      !unreported;
    const failed = tool.status === "failed";
    const sequence = useMemo(
      () => partitionTurnSequence(children, { live: running }),
      [children, running],
    );
    const tailId = sequence.at(-1)?.events.at(-1)?.id ?? null;
    const childCtx = useMemo(
      () => ({ ...ctx, isStreaming: running, lastMessageId: tailId }),
      [ctx, running, tailId],
    );
    const [open, setOpen] = useState(false);
    const [promptOpen, setPromptOpen] = useState(false);
    const bodyId = useId();
    const promptId = useId();
    const Chevron = open ? ChevronDown : ChevronRight;
    if (!toolPresentationReady(tool)) return null;
    return (
      <div className="flex min-w-0 flex-col" data-agent-group="">
        <button
          type="button"
          className="group/subagent-row hover:bg-bg2-hover/40 -ml-2 flex w-fit max-w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left transition-colors"
          onClick={() => setOpen((value) => !value)}
          aria-label={`Agent ${headerText}`}
          aria-description={failed ? "Agent failed" : undefined}
          aria-expanded={open}
          aria-controls={bodyId}
        >
          <span
            data-agent-icon=""
            className={cn(
              "relative inline-flex size-3.5 shrink-0 items-center justify-center",
              failed ? "text-red-primary" : "text-fg2",
            )}
          >
            <span className="inline-flex group-hover/subagent-row:invisible group-focus-visible/subagent-row:invisible">
              {running ? (
                <ZerosSpinner
                  size={14}
                  variant="agent"
                  label="Agent working"
                  className="shrink-0"
                />
              ) : (
                <Bot className="size-3 shrink-0" />
              )}
            </span>
            <Chevron
              aria-hidden="true"
              className="absolute inset-0 hidden size-3.5 group-hover/subagent-row:block group-focus-visible/subagent-row:block"
            />
          </span>
          <span
            className={cn(
              "max-w-[50%] min-w-0 shrink-0 truncate text-sm",
              failed ? "text-red-primary" : "text-fg1",
            )}
          >
            Agent
            {modelLabel ? ` · ${modelLabel}` : ""}
          </span>
          <span
            className={cn(
              "min-w-0 truncate text-xs",
              failed ? "text-red-primary" : "text-fg2",
            )}
          >
            {headerText}
          </span>
        </button>
        {open && (
          <div
            id={bodyId}
            data-agent-children=""
            // Same 8px rhythm as the working feed (WORKING_FEED_GAP) between
            // the prompt row, each working segment, and the output.
            className="border-border2 mt-2 ml-1.5 flex min-w-0 flex-col gap-y-2 border-l pl-4"
          >
            {promptHtml && (
              <div className="flex min-w-0 flex-col">
                <button
                  type="button"
                  className="hover:bg-bg2-hover/40 -ml-2 flex w-fit max-w-full items-center gap-2 rounded-md px-2 py-1 text-left"
                  onClick={() => setPromptOpen((value) => !value)}
                  aria-expanded={promptOpen}
                  aria-controls={promptId}
                >
                  <MessageSquare className="text-fg2 size-3 shrink-0" />
                  <span className="text-fg1 text-sm">Prompt</span>
                </button>
                {promptOpen && (
                  <div
                    id={promptId}
                    className="zeros-agent-md py-2"
                    dangerouslySetInnerHTML={{ __html: promptHtml }}
                  />
                )}
              </div>
            )}
            {sequence.map((segment, index) =>
              segment.kind === "working" ? (
                <EventStripe
                  key={segment.key}
                  events={segment.events}
                  ctx={childCtx}
                  live={running}
                  alwaysExpanded
                  browserTailClosed={
                    index < sequence.length - 1 || !!resultHtml
                  }
                />
              ) : (
                <div key={segment.key} data-agent-output="">
                  <MessageView message={segment.events[0]} ctx={childCtx} />
                </div>
              ),
            )}
            {resultHtml &&
              !resultInChildren &&
              (failed ? (
                <ToolDetailSurface label="Agent error" failed>
                  <div
                    className="zeros-agent-md px-3 py-2"
                    dangerouslySetInnerHTML={{ __html: resultHtml }}
                  />
                </ToolDetailSurface>
              ) : (
                <div
                  className="zeros-agent-md"
                  dangerouslySetInnerHTML={{ __html: resultHtml }}
                />
              ))}
            {!running &&
              !resultHtml &&
              children.length === 0 &&
              output.status !== "async_launched" && (
                <ToolDetailSurface label="Agent details" failed={failed}>
                  {renderDetail(tool, ctx)}
                </ToolDetailSurface>
              )}
          </div>
        )}
      </div>
    );
  },
);

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function agentReportText(tool: AgentToolMessage): string {
  const output = toolRecord(tool.rawOutput);
  // A native async acknowledgement is not the child's report. Retain it in
  // history, but don't print internal launch instructions into the feed.
  if (tool.status === "failed" && typeof output.message === "string")
    return output.message;
  if (output.status === "async_launched") return "";
  const text = (tool.content ?? [])
    .flatMap((block) =>
      block.type === "content" && block.content.type === "text"
        ? [block.content.text]
        : [],
    )
    .join("");
  // Compatibility with older Claude histories that only captured text.
  if (/^Async agent launched successfully\./.test(text.trim())) return "";
  if (text) return text;
  if (typeof output.report === "string") return output.report;
  if (["completed", "async_launched"].includes(String(output.status)))
    return "";
  if (typeof tool.rawOutput === "string") return tool.rawOutput;
  return tool.status === "failed"
    ? (asDisplayString(tool.rawOutput) ?? "")
    : "";
}

/** Retired Claude model slugs still occur in saved transcripts. Format only
 * the version encoded in a native slug; custom model IDs stay verbatim. */
function agentModelLabel(model: string): string {
  const curated = displayNameForModelValue(null, model);
  if (curated !== model) return curated;
  const claude =
    /^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[1m\])?$/.exec(
      model,
    );
  if (claude)
    return `${claude[1][0].toUpperCase()}${claude[1].slice(1)} ${claude[2]}${claude[3] ? `.${claude[3]}` : ""}`;
  return /^(opus|sonnet|haiku)$/.test(model)
    ? model[0].toUpperCase() + model.slice(1)
    : model;
}
