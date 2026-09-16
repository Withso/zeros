// ──────────────────────────────────────────────────────────
// agent-attachments.ts — attachment limits, icons, validation
// ──────────────────────────────────────────────────────────
//
// Three attachment concerns the EmptyComposer needs
// answered as the user attaches files:
//
//   1. What lucide icon should this file's chip show?
//      → iconForFile(name, mime) returns a component reference.
//   2. Is this attachment safe to send under the current agent?
//      → validateAttachment({...}) returns ok | warning | error
//        with a human-readable reason. The chip surfaces the message
//        inline; submission filters out anything not "ok".
//   3. What are the per-agent / per-format size limits?
//      → constants below; tuned conservatively across the agents
//        we support so we don't trip the strictest one.
//
// Attachment intake budgets are independent of delivery: the shared encoder
// persists accepted files and sends a path for every agent. Native prompt image
// capabilities remain available to the harness, but do not select this route.
// ──────────────────────────────────────────────────────────

import {
  Code2,
  FileJson,
  FileText,
  FileType2,
  Image as ImageIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { claudeContextWindow } from "@zeros/protocol/model-context";

/** Maximum bytes per image attachment. Conservative: Claude supports
 *  up to ~30 MB but other API edges + the bridge encode-as-base64
 *  cost make 5 MB a safer cap. The user can paste larger images via
 *  external sharing — this is the inline attach budget. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Hard cap on a single text attachment regardless of model context.
 *  4 MB protects the SQLite payload column + the renderer's
 *  base64-encode hot path; even 1M-context models can't comfortably
 *  hold more than this on top of the user's actual prompt. */
export const HARD_TEXT_CAP_BYTES = 4 * 1024 * 1024;

/** Conservative fallback context window when we can't identify the
 *  picked model. ~100K tokens is the floor for current production
 *  CLIs (older OpenAI o-series, etc.). */
const FALLBACK_CONTEXT_TOKENS = 100_000;

/** Approximate chars-per-token across English / code mixed input.
 *  GPT/Claude all hover around 3.7–4.2; we use 4 for sizing
 *  budgets — close enough that the conservative 50%-of-context
 *  multiplier still leaves headroom for the user prompt + reply. */
const CHARS_PER_TOKEN = 4;

/** Per-model context window (tokens) for the NON-Claude families. Patterns
 *  rather than exact strings so wrapper variants (e.g. `gpt-5.3-codex-fast`)
 *  match the right entry. First match wins; add specific variants ABOVE
 *  generic ones. The 50%-of-context rule applied below leaves the other half
 *  for the user's prompt and the agent's reply.
 *
 *  Claude is NOT listed here — it delegates to `claudeContextWindow` in
 *  @zeros/protocol, which the engine's context gauge uses too. This table used to
 *  carry Claude rows and silently rotted: it had `fable-5[1m]` and
 *  `opus-4-8[1m]` but NO row for `claude-sonnet-5` or `claude-opus-5`, so both
 *  fell through to FALLBACK_CONTEXT_TOKENS — a 100K budget on 1M models
 *  (measured 2026-07-25, before the split). */
const MODEL_CONTEXT_TOKENS: Array<[RegExp, number]> = [
  // GPT / Codex. NOTE: `^gpt-5` is the catch-all that currently answers for
  // the curated 5.6 Sol/Terra/Luna ids (256K). Neither the codex CLI package
  // nor its app-server protocol ships a static per-model context table, so
  // these numbers are NOT independently verifiable from inside this repo —
  // the authoritative figure is `tokenUsage.modelContextWindow`, which the
  // codex adapter already reports to the gauge at runtime.
  // GPT-6 Astra's official model metadata publishes a 1,050,000-token context
  // window (128,000 max output). This is the pre-runtime attachment fallback;
  // a live tokenUsage.modelContextWindow remains authoritative.
  [/^gpt-6-astra(?:$|-)/i, 1_050_000],
  [/gpt-5\.5|gpt-5\.4/i, 256_000],
  [/gpt-5\.3-codex|gpt-5\.3/i, 200_000],
  [/gpt-5-nano/i, 128_000],
  [/^gpt-5/i, 256_000],
  // Cursor composer family — published context window is ~200K.
  // `grok-4.5` is deliberately absent: the @cursor/sdk `turn-ended` usage
  // payload carries only token counts (no context window), so there is
  // nothing to verify against and a guessed constant could over-attach.
  // It resolves to the conservative FALLBACK_CONTEXT_TOKENS instead.
  [/composer-2|composer-1\.5/i, 200_000],
];

/** Resolve the picked model's context window. Returns the fallback
 *  for unknown ids so we always produce a usable budget. */
export function modelContextTokens(modelId: string | null | undefined): number {
  if (!modelId) return FALLBACK_CONTEXT_TOKENS;
  // Claude: shared with the engine's gauge (packages/protocol/src/model-context.ts).
  if (/^claude-/i.test(modelId.trim())) return claudeContextWindow(modelId);
  for (const [pattern, tokens] of MODEL_CONTEXT_TOKENS) {
    if (pattern.test(modelId)) return tokens;
  }
  return FALLBACK_CONTEXT_TOKENS;
}

/** Maximum bytes per text-file attachment, scaled to the picked
 *  model's actual context window. Capped by HARD_TEXT_CAP_BYTES so
 *  large-context models stay under our renderer / SQLite comfort
 *  zone. Multiplied by 0.5 to leave room for the prompt + reply
 *  within the same window. */
export function maxTextBytesForModel(
  modelId: string | null | undefined,
): number {
  const tokens = modelContextTokens(modelId);
  const budget = Math.floor(tokens * 0.5 * CHARS_PER_TOKEN);
  return Math.min(HARD_TEXT_CAP_BYTES, budget);
}

/** Attachment validation outcome. `ok=true` rides through the bridge
 *  unchanged; otherwise the chip surfaces `reason` and the submit
 *  consumer drops the block from the prompt. */
export interface AttachmentValidation {
  ok: boolean;
  reason?: string;
}

/** Returns a lucide icon for a given filename/mime. Differentiates
 *  the most common code + data formats from the generic `text` set
 *  so chips read at a glance — the user can spot a `.json` import
 *  vs. a `.md` doc without reading the filename. */
export function iconForFile(name: string, mimeType: string): LucideIcon {
  if (mimeType.startsWith("image/")) return ImageIcon;
  const lower = name.toLowerCase();
  if (lower.endsWith(".json") || mimeType === "application/json")
    return FileJson;
  if (
    lower.endsWith(".ts") ||
    lower.endsWith(".tsx") ||
    lower.endsWith(".js") ||
    lower.endsWith(".jsx") ||
    lower.endsWith(".py") ||
    lower.endsWith(".rb") ||
    lower.endsWith(".go") ||
    lower.endsWith(".rs") ||
    lower.endsWith(".sh") ||
    lower.endsWith(".bash") ||
    lower.endsWith(".zsh")
  ) {
    return Code2;
  }
  if (
    lower.endsWith(".yaml") ||
    lower.endsWith(".yml") ||
    lower.endsWith(".toml") ||
    lower.endsWith(".csv") ||
    lower.endsWith(".env")
  ) {
    return FileType2;
  }
  // Generic catch-all for .md / .txt / unknown text formats. Same
  // glyph as before so the change is additive — only specialised
  // formats peel off above.
  return FileText;
}

/** Validate an attachment against the active agent's capabilities
 *  and our size budgets. Inputs are kept primitive so this can run
 *  before an Attachment object is even constructed (i.e. at file-
 *  drop time). Reason strings are short and user-facing. The text
 *  budget scales with the picked model's context window so a 1M-token
 *  chat allows a much larger file than a 128K-token Codex chat.
 *
 *  An image is accepted independently of native prompt-image support.
 *  The submit flow writes its bytes to
 *  `<cwd>/.context/<scope>/attachments/...` and references them by path inside
 *  a text block, so EVERY agent at minimum receives the file
 *  location. Vision-capable models (Claude, GPT-5, Cursor Composer-2)
 *  can then call their built-in Read / vision tool on that path;
 *  non-vision models can comment but won't "see" the bytes — honest
 *  fallback. The validation surface only fires for hard size caps now. */
export function validateAttachment(input: {
  kind: "image" | "text";
  size: number;
  agentName: string | null | undefined;
  agentSupportsImage: boolean | undefined;
  /** Picked model id (e.g. "claude-sonnet-4-6", "gpt-5.5"). When
   *  null/undefined we fall back to the conservative 100K-token
   *  budget so unknown models can't accidentally over-attach. */
  modelId: string | null | undefined;
}): AttachmentValidation {
  if (input.kind === "image") {
    if (input.size > MAX_IMAGE_BYTES) {
      return {
        ok: false,
        reason: `Image larger than ${formatBytes(MAX_IMAGE_BYTES)} — won't be sent`,
      };
    }
    return { ok: true };
  }
  // text — budget scales by model context window
  const budget = maxTextBytesForModel(input.modelId);
  if (input.size > budget) {
    return {
      ok: false,
      reason: `File larger than ${formatBytes(budget)} — exceeds the picked model's context budget`,
    };
  }
  return { ok: true };
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${Math.round(n / (1024 * 1024))} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}
