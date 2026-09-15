// Every agent receives confirmed workspace file references. Legacy inline drafts
// are materialized once; transcripts and subsequent edits retain metadata only.
import {
  readImageAttachment,
  readTextAttachment,
} from "./agent-history-client";
import { supplyLegacyAttachmentBytes } from "./attachment-sources";
import type { ComposerAttachment } from "./composer-attachments";
import type { ContentBlock } from "../../platform/bridge/agent-events";
import type { AgentTextMessageAttachment } from "@zeros/protocol/agent-messages";
import {
  ensureFileAttachment,
  fileAttachmentReference,
} from "./file-attachment-transfer";

export interface EncodeAttachmentsContext {
  /** Retained for caller compatibility; file delivery is independent of vision. */
  supportsImage: boolean;
  cwd: string | null;
  chatId: string | null;
  agentId?: string | null;
}

export interface EncodedAttachments {
  blocks: ContentBlock[];
  bubbleAttachments: AgentTextMessageAttachment[];
  bubbleAttachmentById: Map<string, AgentTextMessageAttachment>;
  skipped: { name: string; reason: string }[];
}

/** Compatibility helper for historical inline text consumers. New sends use paths. */
export function textAttachmentBlock(name: string, body: string): string {
  return `<file name="${name.replace(/"/g, "'")}">\n${body}\n</file>`;
}

/** Compatibility encoder for legacy attach-time staging. */
export function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function durableAttachmentId(attachment: ComposerAttachment): string {
  if (attachment.contextAttachmentId) return attachment.contextAttachmentId;
  const match = attachment.diskPath
    ? /^\.context(?:-graph)?\/(?:local|shared)\/attachments\/([a-zA-Z0-9_-]+)\//.exec(
        attachment.diskPath,
      )
    : null;
  return match?.[1] ?? attachment.id;
}

export function reportSkippedAttachments(
  skipped: EncodedAttachments["skipped"],
  warn: (message: string) => void,
): void {
  for (const s of skipped) warn(`"${s.name}" wasn't sent — ${s.reason}.`);
}

export async function encodeAttachments(
  attachments: ComposerAttachment[],
  ctx: EncodeAttachmentsContext,
): Promise<EncodedAttachments> {
  const blocks: ContentBlock[] = [];
  const bubbleAttachments: AgentTextMessageAttachment[] = [];
  const bubbleAttachmentById = new Map<string, AgentTextMessageAttachment>();
  const skipped: { name: string; reason: string }[] = [];

  for (const a of attachments) {
    if (a.unavailable)
      throw new Error(
        `The file for "${a.name}" is unavailable — attach it again before sending`,
      );
    if (!a.validation.ok) {
      skipped.push({
        name: a.name,
        reason:
          a.validation.reason ?? "it exceeds this model's attachment budget",
      });
      continue;
    }
    if (!ctx.cwd)
      throw new Error(`Choose a workspace before sending "${a.name}"`);
    const legacy = a.delivery !== "reference" && a.kind !== "file";
    const hadRecord = !!a.diskPath || !!a.contextAttachmentId;
    if (legacy) supplyLegacyAttachmentBytes(a);
    a.contextAttachmentId = durableAttachmentId(a);
    let written;
    try {
      written = await ensureFileAttachment(ctx.cwd, a);
    } catch (error) {
      // The old chat-scoped image layout predates graph ids. Only this
      // compatibility recovery reads bytes; existing graph records resolve
      // directly and new references never fall back to arbitrary file reads.
      if (
        !legacy ||
        !hadRecord ||
        a.sourceFile ||
        !(error instanceof Error) ||
        !error.message.includes("not available")
      )
        throw error;
      if (a.kind === "image" && a.diskPath) {
        const restored = await readImageAttachment({
          cwd: ctx.cwd,
          diskPath: a.diskPath,
          attachmentId: a.contextAttachmentId,
          mimeType: a.mimeType,
        });
        a.data = restored.base64;
        a.mimeType = restored.mimeType;
      } else if (a.kind === "text") {
        const body = await readTextAttachment({
          cwd: ctx.cwd,
          attachmentId: a.contextAttachmentId,
          diskPath: a.diskPath,
        });
        if (body === null) throw error;
        // A successful read confirms the bytes, including a real empty file.
        a.sourceFile = new Blob([body], { type: a.mimeType });
        a.size = a.sourceFile.size;
      } else throw error;
      supplyLegacyAttachmentBytes(a);
      written = await ensureFileAttachment(ctx.cwd, a);
    }
    a.delivery = "reference";
    a.data = "";
    delete a.text;
    a.size = written.bytes;
    blocks.push({
      type: "text",
      text: fileAttachmentReference(a.name, written),
    });
    const bubble: AgentTextMessageAttachment = {
      name: a.name,
      mimeType: written.mimeType,
      kind: a.kind,
      delivery: "reference",
      size: written.bytes,
      diskPath: written.relativePath,
      attachmentId: a.contextAttachmentId,
    };
    bubbleAttachments.push(bubble);
    bubbleAttachmentById.set(a.id, bubble);
  }
  return { blocks, bubbleAttachments, bubbleAttachmentById, skipped };
}
