import { cursorSearchOutput } from "./search-output";
// ──────────────────────────────────────────────────────────
// EventRowRenderer — adapter from registry's Renderer<M> to EventRow
// ──────────────────────────────────────────────────────────
//
// The registry expects a Renderer<M>
// component shape. EventRow doesn't quite fit (it accepts an
// optional meta override + detail). This adapter is the thin
// glue: takes the message + ctx, computes the detail body for
// its kind, and hands them to EventRow.
//
// Every tool kind except subagent + question routes here. The
// subagent has its own renderer (threaded body); the question
// has its own EventRow-based record (QuestionRecordCard).
// ──────────────────────────────────────────────────────────

import { memo, useState } from "react";
import { FileText, Globe2, SquareMousePointer } from "lucide-react";

import { ZerosSpinner } from "@/renderer/shared/ui/loading";
import { Button } from "@/renderer/shared/ui";
import { toast } from "@/renderer/shared/ui/primitives/elements";
import type { AgentMessage, AgentToolMessage } from "../use-agent-session";
import { commandReadActions, displayCommand, type CommandReadAction } from "./tool-command";
import { EventRow, WORKING_FEED_GAP } from "./event-row";
import { cn } from "@/renderer/shared/ui/cn";
import { ToolIdentityIcon } from "./tool-identity-icon";
import { isImagePath, nativeCodexBrowserPresentation } from "./event-meta";
import {
  cachedBrowserFavicon,
  useConversationBrowserActivity,
} from "../../browser/browser-session-activity-store";
import {
  browserToolActivity,
  browserActivityUsesWebsiteIcon,
  type BrowserToolActivity,
} from "../../browser/browser-tool-activity";
import { CodeWithGutter, HighlightedCode } from "./highlighted-code";
import { parseReadBody } from "./read-lines";
import { readLabel, readLineCount, readToolText } from "./read-output";
import {
  asDisplayString,
  commandResultOutput,
  toolCompletionUnreported,
} from "./raw-output";
import { nativeAgentWait, toolRecord } from "./native-tool-presentation";
import { getLang } from "./syntax";
import type { Renderer, RendererContext } from "./types";

/** Pick a shiki language for a tool's expandable output. We syntax-highlight
 *  ONLY actual code — Read/Edit, by the file's language — because that's where
 *  coloring genuinely helps. Shell/terminal output (Bash/Grep/Glob/ls) returns
 *  `text` and renders plain fg1: command listings, paths and counts aren't
 *  source code, and `bash`-coloring them reads as noisy. */
function langForTool(tool: AgentToolMessage): string {
  const kind = tool.toolKind;
  if (tool.status === "failed" || (kind !== "read" && kind !== "edit")) return "text";
  const input = (
    tool.rawInput && typeof tool.rawInput === "object" ? tool.rawInput : {}
  ) as Record<string, unknown>;
  for (const v of [
    input.file_path,
    input.path,
    input.filePath,
    input.target_file,
  ]) {
    if (typeof v === "string" && v) return getLang(v);
  }
  return "text";
}

// Shared chrome for an expandable output body: the surrounding card + a wrapping,
// monospace, fg1 code surface (shiki tokens override fg1 when highlighted).
const OUTPUT_CLASS =
  "px-3 py-2 font-mono text-sm leading-relaxed text-fg1 [&_pre]:whitespace-pre-wrap [&_pre]:break-words";

function readPathOf(tool: AgentToolMessage): string | null {
  const input = (
    tool.rawInput && typeof tool.rawInput === "object" ? tool.rawInput : {}
  ) as Record<string, unknown>;
  for (const v of [
    input.file_path,
    input.path,
    input.filePath,
    input.target_file,
  ]) {
    if (typeof v === "string" && v) return v;
  }
  return null;
}

export const EventRowRenderer: Renderer<AgentMessage> = memo(
  function EventRowRenderer({ message, ctx }) {
    // A LIVE api_retry notice (the CLI is mid-backoff, this row is the
    // streaming tail) renders as a shimmer + "Reconnecting agent" — an
    // active state, not a warning. The moment the
    // stream resumes past it (or the turn settles) it falls through to the
    // static compact row from event-meta, so a settled transcript never
    // shimmers.
    if (
      message.kind === "error_notice" &&
      (message as { code?: string }).code === "api_retry" &&
      ctx.isStreaming &&
      ctx.lastMessageId === message.id
    ) {
      return (
        <div
          className="text-fg1 flex items-center gap-2 py-1 text-sm"
          role="status"
          aria-live="polite"
        >
          <ZerosSpinner
            size={16}
            label="Reconnecting agent"
            className="shrink-0"
          />
          <span>Reconnecting agent</span>
        </div>
      );
    }
    if (message.kind === "tool") {
      const reads = commandReadActions(message);
      if (reads.length > 1) return <CommandReadRows tool={message} reads={reads} ctx={ctx} />;
      const safetyReview = readSafetyReview(message as AgentToolMessage);
      if (safetyReview) {
        const retryId = ctx.safetyReviewRetries?.[message.toolCallId];
        return (
          <EventRow
            message={message}
            ctx={ctx}
            detail={
              <SafetyReviewDetail
                review={{ ...safetyReview, ...(retryId ? { retryId } : {}) }}
                ctx={ctx}
              />
            }
          />
        );
      }
      const activity = browserToolActivity(message as AgentToolMessage);
      if (activity) {
        return (
          <NativeBrowserToolRow
            tool={message as AgentToolMessage}
            ctx={ctx}
            browserActivity={activity}
          />
        );
      }
    }
    const detail = renderDetail(message, ctx);
    return <EventRow message={message} ctx={ctx} detail={detail} />;
  },
);

/** Every file action stays visible, but only one shared execution result can
 * be open. The SDK does not provide output boundaries for a batched command. */
function CommandReadRows({ tool, reads, ctx }: {
  tool: AgentToolMessage;
  reads: CommandReadAction[];
  ctx: RendererContext;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const label = readLabel(readLineCount(tool), true);
  const detail = (
    <>
      <div className="text-fg2 px-3 pt-2 text-xs">One command reading {reads.length} files; the result below belongs to the whole command.</div>
      {renderDetail(tool, ctx)}
    </>
  );
  // One event → several rows: repeat the feed's gap so these rows space
  // exactly like independent tool calls around them.
  return (
    <div className={cn("flex flex-col", WORKING_FEED_GAP)}>
      {reads.map((read) => (
        <EventRow
          key={read.key}
          message={tool}
          ctx={ctx}
          meta={{ Icon: FileText, label, target: read.path, targetFile: true, targetKind: "file", expandable: true }}
          open={expanded === read.key}
          onOpenChange={(open) => setExpanded(open ? read.key : null)}
          detail={detail}
        />
      ))}
    </div>
  );
}

interface SafetyReviewView {
  status: string;
  actionType?: string;
  riskLevel?: string;
  rationale?: string;
  retryId?: string;
  retried?: boolean;
}

function readSafetyReview(tool: AgentToolMessage): SafetyReviewView | null {
  if (!tool.rawOutput || typeof tool.rawOutput !== "object") return null;
  const value = (tool.rawOutput as Record<string, unknown>).zerosSafetyReview;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const review = value as Record<string, unknown>;
  if (typeof review.status !== "string") return null;
  return {
    status: review.status,
    ...(typeof review.actionType === "string"
      ? { actionType: review.actionType }
      : {}),
    ...(typeof review.riskLevel === "string"
      ? { riskLevel: review.riskLevel }
      : {}),
    ...(typeof review.rationale === "string"
      ? { rationale: review.rationale }
      : {}),
    ...(review.retried === true ? { retried: true } : {}),
  };
}

function SafetyReviewDetail({
  review,
  ctx,
}: {
  review: SafetyReviewView;
  ctx: RendererContext;
}) {
  const [busy, setBusy] = useState(false);
  const retry = async () => {
    if (!review.retryId || busy) return;
    setBusy(true);
    try {
      await ctx.retrySafetyReview(review.retryId);
    } catch (error) {
      toast.error("Couldn't retry the denied action", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="text-fg2 space-y-2 text-sm">
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
        <span>Status: {review.retried ? "Retried" : review.status}</span>
        {review.actionType ? <span>Action: {review.actionType}</span> : null}
        {review.riskLevel ? <span>Risk: {review.riskLevel}</span> : null}
      </div>
      {review.rationale ? (
        <p className="whitespace-pre-wrap">{review.rationale}</p>
      ) : null}
      {review.status === "denied" && review.retryId ? (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() => void retry()}
        >
          Approve and retry once
        </Button>
      ) : null}
    </div>
  );
}

/** Provider-native Browser calls remain ordinary, expandable tool calls, but
 * their leading glyph and copy describe the page action instead of MCP/REPL
 * plumbing. Grouped URL-less actions receive the last recorded page URL so a
 * settled transcript never depends on whichever live tab is active now. */
export function NativeBrowserToolRow({
  tool,
  ctx,
  inheritedUrl,
  browserActivity: browserActivityOverride,
}: {
  tool: AgentToolMessage;
  ctx: RendererContext;
  inheritedUrl?: string;
  browserActivity?: BrowserToolActivity;
}) {
  const session = useConversationBrowserActivity(ctx.chatId ?? undefined);
  const activity = browserActivityOverride ?? browserToolActivity(tool);
  const meta = nativeCodexBrowserPresentation(
    tool,
    activity?.external ? undefined : session?.url,
    activity,
  );
  const usesWebsiteIcon = Boolean(
    activity && browserActivityUsesWebsiteIcon(activity),
  );
  const pageUrl =
    activity?.url ?? (!activity?.external ? inheritedUrl : undefined);
  const faviconDataUrl = usesWebsiteIcon
    ? ((!activity?.external && meta.faviconMatchesLivePage
        ? session?.faviconDataUrl
        : undefined) ?? cachedBrowserFavicon(pageUrl))
    : undefined;
  const siteIcon = usesWebsiteIcon
    ? (faviconDataUrl ??
      activity?.faviconUrl ??
      (activity?.external && pageUrl
        ? new URL("/favicon.ico", pageUrl).href
        : undefined))
    : undefined;
  const NativeIcon = () => (
    <ToolIdentityIcon
      appId={activity?.appId}
      faviconUrl={siteIcon}
      fallback={usesWebsiteIcon ? Globe2 : SquareMousePointer}
      active={ctx.attachmentImagesActive !== false}
      className="size-3"
    />
  );
  return (
    <EventRow
      message={tool}
      ctx={ctx}
      meta={{ ...meta, Icon: NativeIcon }}
      detail={renderDetail(tool, ctx)}
    />
  );
}

export function renderDetail(
  message: AgentMessage,
  ctx: RendererContext,
): React.ReactNode {
  if (message.kind === "tool") return <ToolDetail tool={message} ctx={ctx} />;
  if (message.kind === "text" && message.role === "thought") {
    // Provider boundary/paragraph blanks must not become full-height empty
    // lines. Keep the native text intact; preserve single breaks and indentation.
    const paragraphs = message.text
      .replace(/\r\n?/g, "\n")
      .replace(/^(?:[ \t]*\n)+|(?:\n[ \t]*)+$/g, "")
      .split(/\n(?:[ \t]*\n)+/)
      .filter((paragraph) => paragraph.trim());
    if (paragraphs.length === 0) return null;
    return (
      <div className="text-fg2 flex flex-col gap-2 px-3 text-sm leading-normal">
        {paragraphs.map((paragraph, index) => (
          <p key={index} className="m-0 wrap-anywhere whitespace-pre-wrap">
            {paragraph}
          </p>
        ))}
      </div>
    );
  }
  if (message.kind === "error_notice") {
    // The collapsed row shows a truncated preview (event-meta caps it);
    // expanding reveals the full notice text.
    const m = message as { message?: string };
    if (!m.message) return null;
    return (
      <div className="text-fg2 px-3 py-2 text-sm whitespace-pre-wrap">{m.message}</div>
    );
  }
  return null;
}

function capturedOutput(tool: AgentToolMessage): unknown {
  const raw = commandResultOutput(tool.rawOutput);
  const output = toolRecord(raw);
  if ("exitCode" in output || (tool.toolKind === "execute" && ("stdout" in output || "stderr" in output || typeof output.output === "string")))
    return (typeof output.output === "string" && output.output) ||
      [output.stdout, output.stderr].filter((v) => typeof v === "string" && v).join("\n");
  if (tool.toolKind === "web_search" && "results" in output) return output.results;
  if (tool.toolKind === "read") {
    const value = toolRecord(output.value ?? output.success);
    if (typeof value.content === "string") return value.content;
    if (typeof output.content === "string") return output.content;
  }
  return raw;
}

/** Meaningful operation text; transport metadata remains in the stored event. */
function operationText(tool: AgentToolMessage): string | null {
  const input = toolRecord(tool.rawInput);
  if (
    tool.toolKind === "execute" ||
    (["list", "search"].includes(tool.toolKind ?? "") &&
      typeof input.command === "string")
  )
    return displayCommand(input) ?? asDisplayString(input);
  if (tool.toolKind === "read") return readPathOf(tool);
  if (["search", "list", "fetch", "web_search"].includes(tool.toolKind ?? "")) {
    const action = toolRecord(input.action);
    const values = [input.globPattern ?? input.pattern ?? input.query ?? input.regex ?? action.query ?? action.pattern,
      input.file_path ?? input.path ?? input.targetDirectory ?? input.url ?? action.url];
    const text = values.filter((value): value is string => typeof value === "string" && !!value).join("\n");
    if (text) return text;
  }
  return asDisplayString(tool.rawInput);
}

/** Mounted only while expanded. One operation and its actual result share the
 * surrounding detail surface; no status/JSON-envelope panels or nested scroll. */
function ToolDetail({ tool, ctx }: { tool: AgentToolMessage; ctx: RendererContext }) {
  const wait = nativeAgentWait(tool);
  if (wait) return wait.result ? <HighlightedCode code={wait.result} lang="text" className={OUTPUT_CLASS} /> : null;
  const input = operationText(tool);
  const output = toolRecord(commandResultOutput(tool.rawOutput));
  const unreported = toolCompletionUnreported(tool.rawOutput);
  const nativeEnding = typeof output.status === "string" && ["cancelled", "declined", "interrupted"].includes(output.status)
    ? output.status : null;
  const body = renderToolOutput(tool, ctx);
  return (
    <div className="min-w-0">
      {input && (
        <HighlightedCode
          code={tool.toolKind === "execute" ? `$ ${asDisplayString(input)}` : input}
          lang={tool.toolKind === "execute" ? "shellscript" : "text"}
          className={`${OUTPUT_CLASS} ${body ? "border-border2 border-b" : ""}`}
        />
      )}
      {unreported && <div className="text-fg2 px-3 py-2 text-xs">Completion not reported. The provider did not report whether this tool completed.</div>}
      {nativeEnding && <div className="text-fg2 px-3 py-2 text-xs">The tool was {nativeEnding}.</div>}
      {body ?? (!unreported && !nativeEnding && (
        <div className="text-fg2 px-3 py-2 text-xs italic">
          {tool.status === "failed"
            ? "The tool failed without an explanation."
            : tool.status === "pending" || tool.status === "in_progress"
              ? "Waiting for output."
              : tool.toolKind === "web_search"
                ? Array.isArray(output.results)
                  ? "No search results were returned."
                  : "results" in output
                    ? "The provider did not include search results."
                    : "No search results were captured for this call."
                : "No output was captured."}
        </div>
      ))}
    </div>
  );
}

function renderToolOutput(
  tool: AgentToolMessage,
  ctx: RendererContext,
): React.ReactNode {
  if (tool.toolKind === "search") {
    const text = cursorSearchOutput(tool.rawOutput);
    if (text !== null)
      return (
        <HighlightedCode code={text} lang="text" className={OUTPUT_CLASS} />
      );
  }
  // READ of a text file → a line-numbered, syntax-highlighted code view with
  // the ACTUAL lines read (e.g. 1222–1280, not 1–60). Image reads fall through
  // to the generic content handler below (which renders the <img>).
  if (tool.toolKind === "read" && tool.status !== "failed" && !isImagePath(readPathOf(tool))) {
    const text = readToolText(tool);
    if (text === "" && tool.status === "completed")
      return <div className="text-fg2 px-3 py-2 text-sm">No lines returned.</div>;
    if (text && text.length > 0) {
      const { code, startLine } = parseReadBody(text, tool.rawInput);
      return (
        <CodeWithGutter
          code={code}
          lang={langForTool(tool)}
          startLine={startLine}
        />
      );
    }
  }

  if (tool.content && tool.content.length > 0) {
    const texts: string[] = [];
    const images: string[] = [];
    const audio: string[] = [];
    for (const block of tool.content) {
      const b = block as any;
      if (b.type === "content") {
        const c = b.content;
        if (c?.type === "text" && typeof c.text === "string") {
          texts.push(c.text);
        } else if (
          c?.type === "image" &&
          typeof c.data === "string" &&
          typeof c.mimeType === "string"
        ) {
          // A tool returning an image (screenshot, MCP image result).
          images.push(`data:${c.mimeType};base64,${c.data}`);
        } else if (c?.type === "image" && typeof c.uri === "string") {
          images.push(c.uri);
        } else if (
          c?.type === "audio" &&
          typeof c.data === "string" &&
          typeof c.mimeType === "string" &&
          c.mimeType.startsWith("audio/")
        ) {
          audio.push(`data:${c.mimeType};base64,${c.data}`);
        } else if (c?.type === "resource_link" && typeof c.uri === "string") {
          texts.push(
            [
              c.title ?? c.name,
              c.description,
              `@${c.uri.replace(/^file:\/\//, "")}`,
            ]
              .filter((value) => typeof value === "string" && value)
              .join("\n"),
          );
        } else if (c?.type === "resource" && c.resource) {
          // Embedded resource — show its inline text or a path marker.
          if (typeof c.resource.text === "string") texts.push(c.resource.text);
          else if (typeof c.resource.uri === "string")
            texts.push(`@${String(c.resource.uri).replace(/^file:\/\//, "")}`);
        }
      } else if (b.type === "text" && typeof b.text === "string") {
        // Defensive: a FLAT (un-wrapped) text block from a non-conformant
        // adapter. The per-agent translators normalize these, but native/edge
        // shapes can still land here — never drop them silently.
        texts.push(b.text);
      } else if (b.type === "diff" && typeof b.newText === "string") {
        // A diff block on a NON-edit tool (EditCard owns the `edit` kind).
        // Surface the new content so it isn't invisible.
        const header = typeof b.path === "string" ? `--- ${b.path}\n` : "";
        texts.push(header + b.newText);
      }
      // `terminal` blocks carry no inline text here — the rawOutput
      // fallback below covers shell/terminal output.
    }
    if (texts.length > 0 || images.length > 0 || audio.length > 0) {
      return (
        <div className="min-w-0">
          {ctx.attachmentImagesActive !== false &&
            images.map((src, i) => (
              <img
                key={i}
                src={src}
                alt="tool output"
                className="border-border1 mb-2 max-h-[320px] max-w-full rounded-md border"
              />
            ))}
          {ctx.attachmentImagesActive !== false &&
            audio.map((src, index) => (
              <audio
                key={index}
                controls
                preload="none"
                src={src}
                aria-label="Tool audio output"
                className="mb-2 max-w-full"
              />
            ))}
          {texts.length > 0 && (
            <HighlightedCode
              code={texts.join("\n")}
              lang={langForTool(tool)}
              className={OUTPUT_CLASS}
            />
          )}
        </div>
      );
    }
  }
  // Fall back to captured OUTPUT before raw input — fixes adapters that
  // populate `rawOutput` (or emit only a terminal block) instead of
  // canonical content blocks. The renderer never read rawOutput before,
  // so shell/terminal output silently vanished for some agents.
  const outStr = asDisplayString(capturedOutput(tool));
  if (outStr) {
    return (
      <HighlightedCode
        code={outStr}
        lang={langForTool(tool)}
        className={OUTPUT_CLASS}
      />
    );
  }
  return null;
}
