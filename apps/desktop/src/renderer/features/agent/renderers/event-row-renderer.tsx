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
import { Globe2, SquareMousePointer } from "lucide-react";

import { ZerosSpinner } from "@/renderer/shared/ui/loading";
import { Button } from "@/renderer/shared/ui";
import { toast } from "@/renderer/shared/ui/primitives/elements";
import type { AgentMessage, AgentToolMessage } from "../use-agent-session";
import { EventRow } from "./event-row";
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
import { asDisplayString } from "./raw-output";
import { getLang } from "./syntax";
import type { Renderer, RendererContext } from "./types";

/** Pick a shiki language for a tool's expandable output. We syntax-highlight
 *  ONLY actual code — Read/Edit, by the file's language — because that's where
 *  coloring genuinely helps. Shell/terminal output (Bash/Grep/Glob/ls) returns
 *  `text` and renders plain fg1: command listings, paths and counts aren't
 *  source code, and `bash`-coloring them reads as noisy. */
function langForTool(tool: AgentToolMessage): string {
  const kind = tool.toolKind;
  if (kind !== "read" && kind !== "edit") return "text";
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
  "rounded-md bg-bg2/60 p-2 font-mono text-sm leading-relaxed text-fg1 [&_pre]:whitespace-pre-wrap [&_pre]:break-words";

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

/** Extract a read's text body from canonical content blocks, else rawOutput. */
function readToolText(tool: AgentToolMessage): string | null {
  if (tool.content) {
    const parts: string[] = [];
    for (const block of tool.content) {
      const b = block as any;
      if (
        b.type === "content" &&
        b.content?.type === "text" &&
        typeof b.content.text === "string"
      ) {
        parts.push(b.content.text);
      } else if (b.type === "text" && typeof b.text === "string") {
        parts.push(b.text);
      }
    }
    if (parts.length > 0) return parts.join("\n");
  }
  const out = asDisplayString(tool.rawOutput);
  return out || null;
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
    const detail = renderDetail(message);
    return <EventRow message={message} ctx={ctx} detail={detail} />;
  },
);

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
  const meta = nativeCodexBrowserPresentation(tool, session?.url, activity);
  const usesWebsiteIcon = Boolean(
    activity && browserActivityUsesWebsiteIcon(activity),
  );
  const faviconDataUrl = usesWebsiteIcon
    ? ((meta.faviconMatchesLivePage ? session?.faviconDataUrl : undefined) ??
      cachedBrowserFavicon(activity?.url ?? inheritedUrl))
    : undefined;
  const NativeIcon = !usesWebsiteIcon
    ? SquareMousePointer
    : faviconDataUrl
      ? () => (
          <img src={faviconDataUrl} alt="" className="size-3 rounded-[2px]" />
        )
      : Globe2;
  return (
    <EventRow
      message={tool}
      ctx={ctx}
      meta={{ ...meta, Icon: NativeIcon }}
      detail={renderDetail(tool)}
    />
  );
}

/** Max-height for tool detail bodies (~8 lines of mono). Beyond this,
 *  the body becomes its own scroll container so long bash output /
 *  grep dumps don't push the rest of the conversation off-screen.
 *  User-feedback driven: "max height ~7-8 lines is enough." */
const DETAIL_MAX_H = "max-h-[200px]";

function renderDetail(message: AgentMessage): React.ReactNode {
  if (message.kind === "tool") {
    const tool = message as AgentToolMessage;

    // READ of a text file → a line-numbered, syntax-highlighted code view with
    // the ACTUAL lines read (e.g. 1222–1280, not 1–60). Image reads fall through
    // to the generic content handler below (which renders the <img>).
    if (tool.toolKind === "read" && !isImagePath(readPathOf(tool))) {
      const text = readToolText(tool);
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
          } else if (c?.type === "resource_link" && typeof c.uri === "string") {
            texts.push(`@${c.uri.replace(/^file:\/\//, "")}`);
          } else if (c?.type === "resource" && c.resource) {
            // Embedded resource — show its inline text or a path marker.
            if (typeof c.resource.text === "string")
              texts.push(c.resource.text);
            else if (typeof c.resource.uri === "string")
              texts.push(
                `@${String(c.resource.uri).replace(/^file:\/\//, "")}`,
              );
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
      if (texts.length > 0 || images.length > 0) {
        return (
          <div className={`${DETAIL_MAX_H} overflow-y-auto`}>
            {images.map((src, i) => (
              <img
                key={i}
                src={src}
                alt="tool output"
                className="border-border1 mb-2 max-h-[320px] max-w-full rounded-md border"
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
    const outStr = asDisplayString(tool.rawOutput);
    if (outStr) {
      return (
        <HighlightedCode
          code={outStr}
          lang={langForTool(tool)}
          className={`${DETAIL_MAX_H} overflow-y-auto ${OUTPUT_CLASS}`}
        />
      );
    }
    // Tools with no output (input-only, or pending) — fall back to a JSON
    // view of the raw input so the user can ALWAYS inspect. Highlighted as JSON.
    if (tool.rawInput) {
      return (
        <HighlightedCode
          code={JSON.stringify(tool.rawInput, null, 2)}
          lang="json"
          className={`${DETAIL_MAX_H} bg-bg2/60 text-fg1 overflow-y-auto rounded-md p-2 font-mono text-xs leading-relaxed [&_pre]:break-words [&_pre]:whitespace-pre-wrap`}
        />
      );
    }
    // Last resort: show a stub so the row is still inspectable. Never
    // returns null for a tool — `expandable` in EventRow then drives
    // the +/- affordance off `detail !== undefined`.
    return (
      <div className="text-muted-fg text-xs italic">(no captured output)</div>
    );
  }
  if (message.kind === "text" && (message as any).role === "thought") {
    const text = (message as any).text as string;
    if (!text) return null;
    return (
      <div
        className={`${DETAIL_MAX_H} text-fg2 overflow-y-auto text-sm leading-relaxed whitespace-pre-wrap`}
      >
        {text}
      </div>
    );
  }
  if (message.kind === "error_notice") {
    // The collapsed row shows a truncated preview (event-meta caps it);
    // expanding reveals the full notice text.
    const m = message as { message?: string };
    if (!m.message) return null;
    return (
      <div className="text-fg2 text-sm whitespace-pre-wrap">{m.message}</div>
    );
  }
  return null;
}
