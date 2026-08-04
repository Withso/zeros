// ──────────────────────────────────────────────────────────
// Agent image attachments — validated workspace-local binary storage
// ──────────────────────────────────────────────────────────
//
// Image bytes are transient prompt transport, not transcript metadata. Every
// image that can be edited/re-sent is materialized under the owning chat's
// `.context/attachments/<chatId>/` directory and the message stores only the
// cwd-relative path. This function is shared by the Electron command and the
// engine workspace bridge so desktop and relay clients use one path/safety
// contract.
// ──────────────────────────────────────────────────────────

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface AgentAttachmentWriteArgs {
  chatId: string;
  attachmentId: string;
  base64: string;
  mimeType: string;
  filename: string;
}

export interface AgentAttachmentWriteResult {
  absolutePath: string;
  relativePath: string;
  mimeType: string;
  bytes: number;
}

function requireNonEmpty(value: string, key: string): void {
  if (!value) {
    throw new Error(`agent_attachment: missing required string '${key}'`);
  }
}

const ID_OK = /^[a-zA-Z0-9_-]{1,128}$/;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_BASE64_LENGTH = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4;
const IMAGE_EXTENSION: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "image/x-icon": ".ico",
  "image/avif": ".avif",
  "image/svg+xml": ".svg",
};

function safeFilename(raw: string, mimeType: string): string {
  const base = path.basename(raw.slice(-512));
  const cleaned = base.replace(/[^a-zA-Z0-9._-]+/g, "_");
  const extension = IMAGE_EXTENSION[mimeType];
  if (!extension)
    throw new Error("agent_attachment: unsupported image MIME type");
  const currentExtension = path.extname(cleaned);
  const rawStem = currentExtension
    ? cleaned.slice(0, -currentExtension.length)
    : cleaned;
  const stem = (rawStem || "image").slice(0, 80 - extension.length);
  return `${stem}${extension}`;
}

function errorCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err
    ? String((err as { code?: unknown }).code)
    : undefined;
}

async function ensureDirectory(
  directory: string,
  label: string,
): Promise<void> {
  let stat;
  try {
    stat = await fs.lstat(directory);
  } catch (err) {
    if (errorCode(err) !== "ENOENT") throw err;
    try {
      await fs.mkdir(directory);
    } catch (mkdirErr) {
      if (errorCode(mkdirErr) !== "EEXIST") throw mkdirErr;
    }
    stat = await fs.lstat(directory);
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`agent_attachment: ${label} must not be a symlink`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`agent_attachment: ${label} must be a directory`);
  }
}

async function writeAtomically(
  finalPath: string,
  contents: string | Buffer,
): Promise<void> {
  const temporaryPath = path.join(
    path.dirname(finalPath),
    `.zeros-attachment-${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(temporaryPath, contents, { flag: "wx", mode: 0o600 });
    await fs.rename(temporaryPath, finalPath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

async function ensureContextGitignore(contextDir: string): Promise<void> {
  const ignore = path.join(contextDir, ".gitignore");
  let content: string;
  try {
    const stat = await fs.lstat(ignore);
    if (stat.isSymbolicLink()) {
      throw new Error(
        "agent_attachment: .context/.gitignore must not be a symlink",
      );
    }
    if (!stat.isFile()) {
      throw new Error("agent_attachment: .context/.gitignore must be a file");
    }
    content = await fs.readFile(ignore, "utf8");
  } catch (err) {
    if (errorCode(err) !== "ENOENT") throw err;
    await writeAtomically(ignore, "*\n");
    return;
  }

  const alreadyIgnored = content
    .split(/\r?\n/)
    .some((line) => line.trim() === "*" || line.trim() === "/attachments/");
  if (alreadyIgnored) return;
  const separator = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
  await writeAtomically(ignore, `${content}${separator}/attachments/\n`);
}

export async function writeAgentAttachment(
  cwd: string,
  args: AgentAttachmentWriteArgs,
): Promise<AgentAttachmentWriteResult> {
  requireNonEmpty(cwd, "cwd");
  requireNonEmpty(args.chatId, "chatId");
  requireNonEmpty(args.attachmentId, "attachmentId");
  requireNonEmpty(args.base64, "base64");
  requireNonEmpty(args.mimeType, "mimeType");
  requireNonEmpty(args.filename, "filename");

  if (!ID_OK.test(args.chatId)) {
    throw new Error("agent_attachment: invalid chatId");
  }
  if (!ID_OK.test(args.attachmentId)) {
    throw new Error("agent_attachment: invalid attachmentId");
  }
  if (!path.isAbsolute(cwd)) {
    throw new Error("agent_attachment: cwd must be absolute");
  }
  if (!IMAGE_EXTENSION[args.mimeType]) {
    throw new Error("agent_attachment: unsupported image MIME type");
  }
  if (
    args.base64.length > MAX_BASE64_LENGTH ||
    args.base64.length % 4 === 1 ||
    !/^[a-zA-Z0-9+/]*={0,2}$/.test(args.base64)
  ) {
    throw new Error("agent_attachment: image payload is invalid or too large");
  }

  const buf = Buffer.from(args.base64, "base64");
  if (buf.length > MAX_IMAGE_BYTES) {
    throw new Error("agent_attachment: image payload is too large");
  }

  let cwdStat;
  try {
    cwdStat = await fs.stat(cwd);
  } catch (err) {
    if (errorCode(err) === "ENOENT") {
      throw new Error("agent_attachment: cwd does not exist");
    }
    throw err;
  }
  if (!cwdStat.isDirectory()) {
    throw new Error("agent_attachment: cwd must be a directory");
  }

  const contextDir = path.join(cwd, ".context");
  const attachmentsDir = path.join(contextDir, "attachments");
  const attachmentsRoot = path.join(attachmentsDir, args.chatId);
  await ensureDirectory(contextDir, ".context");
  await ensureDirectory(attachmentsDir, ".context/attachments");
  await ensureDirectory(attachmentsRoot, "chat attachment directory");
  await ensureContextGitignore(contextDir);

  const safeName = safeFilename(args.filename, args.mimeType);
  const finalName = `${args.attachmentId}-${safeName}`;
  const finalPath = path.join(attachmentsRoot, finalName);
  if (!finalPath.startsWith(attachmentsRoot + path.sep)) {
    throw new Error("agent_attachment: refusing to write outside chat root");
  }

  await writeAtomically(finalPath, buf);
  return {
    absolutePath: finalPath,
    relativePath: path.relative(cwd, finalPath),
    mimeType: args.mimeType,
    bytes: buf.length,
  };
}
