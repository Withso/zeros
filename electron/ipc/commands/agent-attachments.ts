// ──────────────────────────────────────────────────────────
// IPC commands: agent-attachments — attachment bytes on/off disk
// ──────────────────────────────────────────────────────────
//
// Phase D2 (2026-05-07), re-homed 2026-08-02. The renderer can't write files
// directly (the sandbox model + WebSocket bridge both prefer text payloads),
// so this handler moves a base64-encoded attachment into the workspace's
// context graph:
//
//   <cwd>/.context-graph/<scope>/attachments/<attachmentId>/<safeFilename>
//
// One folder per attachment, exactly one file inside — the layout the Context
// tab canvas renders and the share checkbox moves between `local/`
// (gitignored) and `shared/` (committed). EVERY composer attachment lands
// here the moment it is staged in the composer — images AND text files / chat
// transcripts. Write is the ONLY verb: the graph is append-only from the app
// (2026-08-03(3) — removing a chip from the composer must never delete the
// workspace's record of the file; the `agent_attachment_remove` command that
// once did is deleted). Files leave the graph only when the user deletes
// them on disk.
//
// Why store under the chat's cwd instead of a global temp dir?
//   1. The agent's CLI runs with cwd = chatFolder. Saving here means
//      `@.context-graph/...` works as a relative path.
//   2. The user can browse the directory in Finder/VS Code — and the Context
//      tab — and see what's actually being shipped.
//   3. The graph belongs to the WORKSPACE (it survives chat deletion and is
//      force-added into the archive snapshot), so a workspace's context
//      record outlives any one chat and even the worktree itself.
//
// Path safety lives in src/engine/files/context-graph.ts (the ONE
// implementation, shared with the engine bridge ops): ids validated as
// a-zA-Z0-9_-, filenames reduced to a sanitised basename, and every resolved
// path confined to the workspace lexically + by realpath. These handlers only
// validate arg SHAPES and translate structured failures into throws.
// ──────────────────────────────────────────────────────────

import * as path from "node:path";
import { stageContextGraphAttachment } from "../../../src/engine/files/context-graph";
import type { CommandHandler } from "../router";

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`agent_attachment: missing required string '${key}'`);
  }
  return v;
}

const ID_OK = /^[a-zA-Z0-9_-]+$/;

/** agent_attachment_write — persist a base64-encoded attachment into the
 *  workspace's context graph and return the absolute path. The renderer
 *  calls this the moment an attachment is staged in the composer (and again
 *  from the send path as a cheap idempotent safety net): images so non-vision
 *  agents can Read them by path, text files / transcripts so the Context tab
 *  shows what was attached.
 *
 *  `chatId` is accepted for provenance but OPTIONAL — the graph is
 *  workspace-scoped, and staging must work before the first prompt creates
 *  the chat. */
export const agentAttachmentWrite: CommandHandler = async (args) => {
  const cwd = requireString(args, "cwd");
  const attachmentId = requireString(args, "attachmentId");
  const base64 = requireString(args, "base64");
  const mimeType = requireString(args, "mimeType");
  const filename = requireString(args, "filename");
  const chatId = args.chatId;

  if (
    chatId !== undefined &&
    chatId !== null &&
    (typeof chatId !== "string" || !ID_OK.test(chatId))
  ) {
    throw new Error("agent_attachment: invalid chatId");
  }
  if (!ID_OK.test(attachmentId)) {
    throw new Error("agent_attachment: invalid attachmentId");
  }
  if (!path.isAbsolute(cwd)) {
    throw new Error("agent_attachment: cwd must be absolute");
  }

  const staged = await stageContextGraphAttachment(cwd, {
    attachmentId,
    base64,
    filename,
  });
  if (!staged.ok) {
    throw new Error(
      `agent_attachment: ${staged.error ?? "couldn't stage the attachment"}`,
    );
  }

  // The renderer needs both the absolute path (for tool-call paths
  // like Read("/abs/path")) and the cwd-relative path (for @-mentions
  // like @.context-graph/local/attachments/...). Ship both so the prompt
  // builder can pick whichever the active agent prefers.
  return {
    absolutePath: staged.absolutePath,
    relativePath: staged.relativePath,
    mimeType,
    bytes: staged.bytes,
  };
};
