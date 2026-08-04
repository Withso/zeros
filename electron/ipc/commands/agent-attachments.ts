// ──────────────────────────────────────────────────────────
// IPC commands: agent-attachments — write image bytes to disk
// ──────────────────────────────────────────────────────────
//
// Phase D2 (2026-05-07). The renderer can't write files directly
// (the sandbox model + WebSocket bridge both prefer text payloads),
// so this IPC handler takes a base64-encoded image, decodes it, and
// writes it under `<cwd>/.context/attachments/<chatId>/<id>-<safeFilename>`.
// The renderer then references the resulting absolute path inside a
// text ContentBlock so any agent (vision-capable or not) sees the
// attachment as an addressable file rather than an opaque image
// block its CLI doesn't understand.
//
// Why store under the chat's cwd instead of a global temp dir?
//   1. The agent's CLI runs with cwd = chatFolder. Saving here means
//      `@.context/attachments/...` works as a relative path.
//   2. The user can browse the directory in Finder/VS Code and see
//      what's actually being shipped.
//   3. Wiping a chat (clearChat) can also wipe its attachments dir.
//
// Path safety:
//   - chatId / attachmentId are validated as a-zA-Z0-9_-.
//   - filename is sanitised — only the basename is used, special
//     chars replaced with `_`, and capped to 80 chars so a hostile
//     drag-source can't path-traverse.
//   - Final write path is verified to start with the validated
//     attachments root before fs.writeFile is called.
// ──────────────────────────────────────────────────────────

import path from "node:path";

import type { CommandHandler } from "../router";
import { writeAgentAttachment } from "../../../src/engine/files/agent-attachment";
import { zerosWorkspacesRoot } from "../../../src/engine/db/paths";
import { currentRoot } from "../../sidecar";

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`agent_attachment: missing required string '${key}'`);
  }
  return v;
}

function cwdIsTrusted(cwd: string): boolean {
  const resolved = path.resolve(cwd);
  const roots = [currentRoot(), zerosWorkspacesRoot()].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return roots.some((root) => {
    const trusted = path.resolve(root);
    return resolved === trusted || resolved.startsWith(trusted + path.sep);
  });
}

/** agent_attachment_write — persist a base64-encoded attachment to
 *  the chat's working directory and return the absolute path. The
 *  renderer calls this once per image attachment when the picked
 *  agent doesn't natively accept image content blocks; the path is
 *  then woven into the prompt as a text reference so every agent —
 *  vision-capable or not — at minimum knows the user attached a
 *  file at this location. */
export const agentAttachmentWrite: CommandHandler = async (args) => {
  const cwd = requireString(args, "cwd");
  const chatId = requireString(args, "chatId");
  const attachmentId = requireString(args, "attachmentId");
  const base64 = requireString(args, "base64");
  const mimeType = requireString(args, "mimeType");
  const filename = requireString(args, "filename");

  if (!cwdIsTrusted(cwd)) {
    throw new Error(
      "agent_attachment: refusing to write outside the workspace",
    );
  }

  return writeAgentAttachment(cwd, {
    chatId,
    attachmentId,
    base64,
    mimeType,
    filename,
  });
};
