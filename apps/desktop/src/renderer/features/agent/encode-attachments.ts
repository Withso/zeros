// ──────────────────────────────────────────────────────────
// encode-attachments — staged ComposerAttachments → ContentBlocks
// ──────────────────────────────────────────────────────────
//
// The ONE place a staged attachment becomes wire content. Extracted
// 2026-07-30 because there were two of these and only one was correct:
//
//   • editAndResubmit (agent-chat.tsx) had the `kind === "text"` branch and
//     honoured `validation.ok`.
//   • encodeComposerAttachments — the encoder BOTH live send paths use
//     (handleSend and the queued-edit save) — had neither. Every text
//     attachment was emitted as `{type:"image", data:""}`, which the vision
//     path drops silently (falsy base64 → no source.url), the non-vision path
//     throws on (requireString in writeContextAttachment), and Codex turns into
//     a zero-byte temp file. So dragging a .md into the composer rendered a
//     chip, sent successfully, and the agent never saw the file.
//
// The asymmetry is why the bug survived: a .txt attached while EDITING an
// already-sent message did arrive, so the feature looked half-working rather
// than broken.
//
// Text attachments are INLINED into the prompt as `<file name="…">body</file>`
// — there is no disk round-trip and no @path indirection. That is deliberate:
// "the agent knows what happened" must not degrade to "the agent could find
// out" (agents routinely skim or skip a referenced file).
//
// 2026-08-02: every valid attachment is ADDITIONALLY persisted into the
// workspace's context graph (`.context-graph/<scope>/attachments/<id>/<file>`)
// — the store the Context tab canvas renders. Since attach-time staging
// (composer-editor/context-graph-staging.ts) the graph copy normally already
// exists by the time a send encodes; the write here is an idempotent safety
// net (the engine skips byte-identical re-writes), kept because the send is the
// last moment the bytes are certainly in memory. Text copies remain a
// best-effort side effect because their prompt block already carries the body.
// Image copies are awaited for every agent: transcript JSON keeps only the
// returned disk path, never a full-resolution data URL. Vision agents still
// receive the transient inline block; non-vision agents receive the path.
// ──────────────────────────────────────────────────────────

import { imageReferenceBlock } from "./agent-attachments";
import {
  readImageAttachment,
  writeContextAttachment,
} from "./agent-history-client";
import { RECONSTRUCTED_ATTACHMENT_ID_PREFIX } from "./composer-editor/reconstruct";
import type { ComposerAttachment } from "./composer-attachments";
import type { ContentBlock } from "../../platform/bridge/agent-events";
import type { AgentTextMessageAttachment } from "@zeros/protocol/agent-messages";

/** Everything the encoder needs from the surrounding session. Passed in rather
 *  than read from a hook so the function stays callable from both the live
 *  send path and the edit-resubmit path, and testable without a React tree. */
export interface EncodeAttachmentsContext {
  /** False only for agents whose promptCapabilities.image is explicitly false.
   *  Undefined capabilities mean "assume yes" — the adapter drops what it
   *  can't use, and guessing "no" would write files nobody reads. */
  supportsImage: boolean;
  /** Working directory to persist non-vision images under. */
  cwd: string | null;
  /** Provenance only — the graph is workspace-scoped, so encoding (and its
   *  graph writes) works before the first prompt creates the chat. */
  chatId: string | null;
  /** Chooses the @-mention vs absolute-path form of an image reference. */
  agentId: string | null;
}

export interface EncodedAttachments {
  blocks: ContentBlock[];
  bubbleAttachments: AgentTextMessageAttachment[];
  /** Ephemeral composer-id lookup used to stamp disk references onto ordered
   *  message segments. Composer ids themselves are not persisted there. */
  bubbleAttachmentById: Map<string, AgentTextMessageAttachment>;
  /** Attachments that will NOT reach the agent, with why.
   *
   *  Returned rather than logged because dropping silently is the bug this
   *  module exists to end, and the reasons are all reachable in normal use:
   *  a verdict stamped under one model and sent under another, a body the
   *  editor could not reconstruct, a disk write that failed. The caller owns
   *  telling the user — it is the one that knows a send just happened. */
  skipped: { name: string; reason: string }[];
}

/** The inline form a text attachment takes in the prompt.
 *
 *  Quotes in the name are folded to apostrophes rather than escaped: the
 *  wrapper is read by a model, not a parser, and a backslash escape inside an
 *  XML-ish attribute is likelier to confuse than a `'`. */
export function textAttachmentBlock(name: string, body: string): string {
  return `<file name="${name.replace(/"/g, "'")}">\n${body}\n</file>`;
}

/** UTF-8 → base64 without Node's Buffer (this runs in the renderer). Chunked
 *  so a multi-MB text attachment doesn't blow the argument-spread limit.
 *  Exported for the composer's attach-time staging, which encodes the same
 *  text bodies for the same IPC. */
export function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Best-effort copy of an attachment into the workspace's context graph.
 *  Fire-and-forget BY DESIGN, on both axes: the inline block already carries
 *  the bytes, so a failed copy (for example, without native IPC) is a cosmetic gap on
 *  the canvas, not a dropped attachment — and awaiting N additive disk writes
 *  would put avoidable latency on the send path. Only the non-vision image
 *  path awaits its write, because there the PATH is the delivery. */
function stageInContextGraph(
  ctx: EncodeAttachmentsContext,
  a: { id: string; name: string; mimeType: string },
  base64: string,
): void {
  if (!ctx.cwd) return;
  // A reconstructed chip (edit-in-place rebuilds sent messages with fresh
  // ids — reconstruct.ts) is the SAME file the original send already
  // recorded under its original id. Re-staging it would add a duplicate
  // card to the canvas on every edit-resubmit.
  if (a.id.startsWith(RECONSTRUCTED_ATTACHMENT_ID_PREFIX)) return;
  // Promise.resolve also absorbs a SYNCHRONOUS throw from the IPC façade —
  // fire-and-forget must never take the send down with it.
  void Promise.resolve()
    .then(() =>
      writeContextAttachment({
        cwd: ctx.cwd!,
        chatId: ctx.chatId ?? undefined,
        attachmentId: a.id,
        base64,
        mimeType: a.mimeType,
        filename: a.name,
      }),
    )
    .catch((err) => {
      // Additive — the inline block already carries the bytes — but never
      // silent: a rejected copy here is the same signal the attach-time
      // reporter surfaces, and the log line is what makes a stale-main or
      // read-only-disk outage diagnosable from app.jsonl.
      console.warn(
        `[Zeros] context-graph copy failed for "${a.name}":`,
        err instanceof Error ? err.message : err,
      );
    });
}

/** Edit-in-place gives a reconstructed chip a fresh composer id, but its image
 *  already owns a durable graph record. Reuse that record's id for the
 *  idempotent send-time write instead of creating a duplicate canvas card. */
function durableAttachmentId(attachment: ComposerAttachment): string {
  if (attachment.contextAttachmentId) {
    return attachment.contextAttachmentId;
  }
  const match =
    typeof attachment.diskPath === "string"
      ? /^\.context-graph\/(?:local|shared)\/attachments\/([a-zA-Z0-9_-]+)\//.exec(
          attachment.diskPath,
        )
      : null;
  return match?.[1] ?? attachment.id;
}

/** Hand `skipped` to the user, one warning per attachment.
 *
 *  Lives beside the producer, and takes the notifier rather than importing
 *  one, so the wording is defined once and stays testable without a toast
 *  host. `skipped` is only worth returning if EVERY send path reports it, and
 *  for a while only `handleSend` did: edit-resubmit and the queued-edit save
 *  both destructured around it, so re-sending a message whose transcript chip
 *  could not be reconstructed dropped the attachment AND said nothing — the
 *  exact silent drop this module was extracted to end.
 *
 *  Callers pass `toast.warning`. Not `toast.error`: the prompt itself did
 *  send, and everything else on it arrived. */
export function reportSkippedAttachments(
  skipped: EncodedAttachments["skipped"],
  warn: (message: string) => void,
): void {
  for (const s of skipped) warn(`"${s.name}" wasn't sent — ${s.reason}.`);
}

/** Materialize staged attachments into ContentBlocks + sent-bubble metadata.
 *
 *  Invalid attachments are skipped. `agent-attachments.ts` documents that
 *  "submission filters out anything not ok", and until this function existed
 *  only the edit path honoured it — so an over-budget file was sent and
 *  silently discarded downstream, which is the worst of both outcomes. */
export async function encodeAttachments(
  attachments: ComposerAttachment[],
  ctx: EncodeAttachmentsContext,
): Promise<EncodedAttachments> {
  const blocks: ContentBlock[] = [];
  const bubbleAttachments: AgentTextMessageAttachment[] = [];
  const bubbleAttachmentById = new Map<string, AgentTextMessageAttachment>();
  const skipped: { name: string; reason: string }[] = [];

  for (const a of attachments) {
    if (!a.validation.ok) {
      skipped.push({
        name: a.name,
        reason:
          a.validation.reason ?? "it exceeds this model's attachment budget",
      });
      continue;
    }

    if (a.kind === "text") {
      // An empty body is not an empty file — it is a body we do not have.
      // The edit-resubmit path reconstructs text chips from the sent bubble,
      // which stores the NAME but never the bytes, so re-sending would emit
      // `<file name="x.txt"></file>` and tell the agent that chat was empty.
      // Saying nothing and reporting it beats asserting something false.
      if (!a.text) {
        skipped.push({
          name: a.name,
          reason: "its contents aren't available to re-send — attach it again",
        });
        continue;
      }
      blocks.push({
        type: "text" as const,
        text: textAttachmentBlock(a.name, a.text),
      });
      const bubbleAttachment: AgentTextMessageAttachment = {
        name: a.name,
        mimeType: a.mimeType,
        kind: "text",
        attachmentId: a.id,
      };
      bubbleAttachments.push(bubbleAttachment);
      bubbleAttachmentById.set(a.id, bubbleAttachment);
      // The prompt carries the body inline; the graph copy is what makes the
      // attachment visible on the Context tab canvas.
      stageInContextGraph(ctx, a, utf8ToBase64(a.text));
      continue;
    }

    let imageBase64 = a.data;
    let imageMimeType = a.mimeType;
    if (!imageBase64 && a.diskPath && ctx.cwd) {
      try {
        const restored = await readImageAttachment({
          cwd: ctx.cwd,
          diskPath: a.diskPath,
          attachmentId: a.contextAttachmentId,
          mimeType: a.mimeType,
        });
        imageBase64 = restored.base64;
        imageMimeType = restored.mimeType;
      } catch {
        skipped.push({
          name: a.name,
          reason: "its saved copy isn't available — attach it again",
        });
        continue;
      }
    }
    if (!imageBase64) {
      skipped.push({
        name: a.name,
        reason: "its image bytes aren't available — attach it again",
      });
      continue;
    }

    // Without an owning workspace there is nowhere safe to keep a transcript
    // image. Preserve the wire send but keep the persisted metadata byte-free;
    // a later edit will explicitly ask the user to attach it again.
    if (!ctx.cwd) {
      blocks.push({
        type: "image" as const,
        mimeType: imageMimeType,
        data: imageBase64,
      });
      const bubbleAttachment: AgentTextMessageAttachment = {
        name: a.name,
        mimeType: imageMimeType,
        kind: "image",
        attachmentId: a.id,
      };
      bubbleAttachments.push(bubbleAttachment);
      bubbleAttachmentById.set(a.id, bubbleAttachment);
      continue;
    }

    try {
      const attachmentId = durableAttachmentId(a);
      const written = await writeContextAttachment({
        cwd: ctx.cwd,
        chatId: ctx.chatId ?? undefined,
        attachmentId,
        base64: imageBase64,
        mimeType: imageMimeType,
        filename: a.name,
      });
      if (ctx.supportsImage) {
        blocks.push({
          type: "image" as const,
          mimeType: imageMimeType,
          data: imageBase64,
        });
      } else {
        blocks.push({
          type: "text" as const,
          text: imageReferenceBlock({
            agentId: ctx.agentId,
            filename: a.name,
            absolutePath: written.absolutePath,
            relativePath: written.relativePath,
            mimeType: imageMimeType,
          }),
        });
      }
      const bubbleAttachment: AgentTextMessageAttachment = {
        name: a.name,
        mimeType: imageMimeType,
        kind: "image",
        diskPath: written.relativePath,
        attachmentId,
      };
      bubbleAttachments.push(bubbleAttachment);
      bubbleAttachmentById.set(a.id, bubbleAttachment);
    } catch (err) {
      console.warn(
        `[Zeros agent-chat] failed to persist image ${a.name}:`,
        err,
      );
      skipped.push({ name: a.name, reason: "it couldn't be saved to disk" });
    }
  }

  return { blocks, bubbleAttachments, bubbleAttachmentById, skipped };
}
