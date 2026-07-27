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

import * as fs from "node:fs/promises";
import * as path from "node:path";
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

/** Drop a `.gitignore` (`*`) into `.context` on first use so attachments — and
 *  anything else Zeros stages there — never surface in the user's `git status`.
 *  `*` ignores the entire dir, the `.gitignore` included. Idempotent; the caller
 *  has already created `contextDir`. */
async function ensureContextGitignore(contextDir: string): Promise<void> {
  const ignore = path.join(contextDir, ".gitignore");
  try {
    await fs.access(ignore);
  } catch {
    await fs.writeFile(ignore, "*\n");
  }
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

  if (!ID_OK.test(chatId)) {
    throw new Error("agent_attachment: invalid chatId");
  }
  if (!ID_OK.test(attachmentId)) {
    throw new Error("agent_attachment: invalid attachmentId");
  }
  if (!path.isAbsolute(cwd)) {
    throw new Error("agent_attachment: cwd must be absolute");
  }

  // Attachments live in the repo's `.context/` (gitignored), NOT `.zeros/`
  // (which is being retired from the repo / freed for a future use). The
  // `.context/.gitignore` keeps every staged artifact out of `git status`.
  const contextDir = path.join(cwd, ".context");
  const attachmentsRoot = path.join(contextDir, "attachments", chatId);
  await fs.mkdir(attachmentsRoot, { recursive: true });
  await ensureContextGitignore(contextDir);

  const safeName = safeFilename(filename);
  // Prefix with the attachment id so two files with the same source
  // basename don't clobber each other when dropped together.
  const finalName = `${attachmentId}-${safeName}`;
  const finalPath = path.join(attachmentsRoot, finalName);

  // Belt: ensure the resolved write path stays inside the chat's
  // attachments root. path.basename + ID_OK + the join above already
  // make this true, but the check protects against future regressions
  // (e.g. someone bypasses safeFilename and lets `..` slip through).
  if (!finalPath.startsWith(attachmentsRoot + path.sep)) {
    throw new Error("agent_attachment: refusing to write outside chat root");
  }

  const buf = Buffer.from(base64, "base64");
  await fs.writeFile(finalPath, buf);

  // The renderer needs both the absolute path (for tool-call paths
  // like Read("/abs/path")) and the cwd-relative path (for @-mentions
  // like @.zeros/attachments/...). Ship both so the prompt builder
  // can pick whichever the active agent prefers.
  const relativePath = path.relative(cwd, finalPath);
  return {
    absolutePath: finalPath,
    relativePath,
    mimeType,
    bytes: buf.length,
  };
};
