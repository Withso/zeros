// ──────────────────────────────────────────────────────────
// IPC commands: agent-attachments — write attachment bytes to disk
// ──────────────────────────────────────────────────────────
//
// Phase D2 (2026-05-07), re-homed 2026-08-02. The renderer can't write files
// directly (the sandbox model + WebSocket bridge both prefer text payloads),
// so this IPC handler takes a base64-encoded attachment, decodes it, and
// writes it under the workspace's context graph:
//
//   <cwd>/.context-graph/local/attachments/<attachmentId>/<safeFilename>
//
// One folder per attachment, exactly one file inside — the layout the Context
// tab canvas renders and the share checkbox moves between `local/` (gitignored)
// and `shared/` (committed). EVERY composer attachment lands here now — images
// (which non-vision agents also reference by path) AND text files / chat
// transcripts (which are additionally inlined into the prompt).
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
// Path safety:
//   - chatId / attachmentId are validated as a-zA-Z0-9_-.
//   - filename is sanitised — only the basename is used, special
//     chars replaced with `_`, and capped to 80 chars so a hostile
//     drag-source can't path-traverse.
//   - Final write path is verified to start with the validated
//     attachments root before fs.writeFile is called.
// ──────────────────────────────────────────────────────────

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  CONTEXT_GRAPH_DIR,
  CONTEXT_GRAPH_LOCAL,
  ensureContextGraph,
} from "../../../src/engine/files/context-graph";
import type { CommandHandler } from "../router";

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`agent_attachment: missing required string '${key}'`);
  }
  return v;
}

const ID_OK = /^[a-zA-Z0-9_-]+$/;

function safeFilename(raw: string): string {
  // Strip directory parts; keep extension. Hard cap to 80 chars.
  const base = path.basename(raw);
  const cleaned = base.replace(/[^a-zA-Z0-9._-]+/g, "_");
  return cleaned.length <= 80 ? cleaned : cleaned.slice(0, 80);
}

/** agent_attachment_write — persist a base64-encoded attachment into the
 *  workspace's context graph and return the absolute path. The renderer
 *  calls this for every staged attachment on send: images so non-vision
 *  agents can Read them by path (and vision sends have a durable record),
 *  text files / transcripts so the Context tab shows what was attached. */
export const agentAttachmentWrite: CommandHandler = async (args) => {
  const cwd = requireString(args, "cwd");
  const chatId = requireString(args, "chatId");
  const attachmentId = requireString(args, "attachmentId");
  const base64 = requireString(args, "base64");
  const mimeType = requireString(args, "mimeType");
  const filename = requireString(args, "filename");

  if (!ID_OK.test(chatId)) {
    throw new Error("agent_attachment: invalid chatId");
  }
  if (!ID_OK.test(attachmentId)) {
    throw new Error("agent_attachment: invalid attachmentId");
  }
  if (!path.isAbsolute(cwd)) {
    throw new Error("agent_attachment: cwd must be absolute");
  }

  // Attachments live in the workspace's `.context-graph/` — `local/` scope
  // (gitignored via the graph's own .gitignore) until the user shares them
  // from the Context tab. The scaffold call is idempotent and also (re)writes
  // that .gitignore, so a hand-deleted skeleton heals here.
  const scaffold = await ensureContextGraph(cwd);
  if (!scaffold.ok) {
    throw new Error(
      `agent_attachment: ${scaffold.error ?? "couldn't scaffold the context graph"}`,
    );
  }
  const attachmentsRoot = path.join(
    cwd,
    CONTEXT_GRAPH_DIR,
    CONTEXT_GRAPH_LOCAL,
    "attachments",
    attachmentId,
  );
  await fs.mkdir(attachmentsRoot, { recursive: true });

  const safeName = safeFilename(filename);
  const finalPath = path.join(attachmentsRoot, safeName);

  // Belt: ensure the resolved write path stays inside the attachment's own
  // folder. path.basename + ID_OK + the join above already make this true,
  // but the check protects against future regressions (e.g. someone bypasses
  // safeFilename and lets `..` slip through).
  if (!finalPath.startsWith(attachmentsRoot + path.sep)) {
    throw new Error("agent_attachment: refusing to write outside chat root");
  }

  const buf = Buffer.from(base64, "base64");
  await fs.writeFile(finalPath, buf);

  // The renderer needs both the absolute path (for tool-call paths
  // like Read("/abs/path")) and the cwd-relative path (for @-mentions
  // like @.context-graph/local/attachments/...). Ship both so the prompt
  // builder can pick whichever the active agent prefers.
  const relativePath = path.relative(cwd, finalPath);
  return {
    absolutePath: finalPath,
    relativePath,
    mimeType,
    bytes: buf.length,
  };
};
