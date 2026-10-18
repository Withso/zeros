// ──────────────────────────────────────────────────────────
// Local provider connection changes (shared)
// ──────────────────────────────────────────────────────────
//
// When the user switches a Local provider between an API key, its CLI login
// and saved accounts, the gateway hands each live execution the complete set
// of connection variables for its next turn. Claude and Codex keep every
// conversation under the native root that connection selects
// (CLAUDE_CONFIG_DIR / CODEX_HOME). Moving to another root therefore also
// carries the conversation's history there, or the resume would report
// "No conversation found" / "no rollout found" and the chat would lose its
// context.
//
// The source history stays where it is. A destination copy is replaced only
// by a newer source, so switching A → B → A keeps the latest turns.
// ──────────────────────────────────────────────────────────

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, opendir, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ProviderCredentialUpdate } from "../../types";
import { openOwnedTranscript, ownedTranscriptPath } from "./transcript-file";

/** The execution env with the update's connection variables applied: listed
 * names absent from the update are removed, never left at their old value. */
export function withProviderConnection(
  env: Readonly<Record<string, string>> | undefined,
  update: Pick<ProviderCredentialUpdate, "keys" | "env">,
): Record<string, string> {
  const next = { ...(env ?? {}) };
  for (const key of update.keys) {
    const value = update.env[key];
    if (typeof value === "string") next[key] = value;
    else delete next[key];
  }
  return next;
}

/** The root a provider process launched with `env` keeps its history under. */
export function nativeHistoryRoot(
  provider: "claude" | "codex",
  env: Readonly<Record<string, string>> | undefined,
): string {
  const explicit =
    env?.[provider === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"]?.trim();
  if (explicit) return path.resolve(explicit);
  return path.join(
    env?.HOME?.trim() || os.homedir(),
    provider === "claude" ? ".claude" : ".codex",
  );
}

const NATIVE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_SCAN_ENTRIES = 32_768;
const MAX_SIDECAR_FILES = 2_048;
const MAX_SIDECAR_DEPTH = 4;

interface ScanBudget {
  remaining: number;
}

async function directoryNames(
  root: string,
  directory: string,
  budget: ScanBudget,
  accept: (entry: { name: string; isDirectory(): boolean; isFile(): boolean }) => boolean,
): Promise<string[]> {
  const names: string[] = [];
  let handle;
  try {
    handle = await opendir(await ownedTranscriptPath(root, directory));
  } catch {
    return names;
  }
  for await (const entry of handle) {
    if (--budget.remaining < 0) break;
    if (accept(entry)) names.push(entry.name);
  }
  return names;
}

/** Copy one regular file to the same relative path under another root. */
async function carryFile(from: string, to: string, relative: string): Promise<void> {
  const source = await openOwnedTranscript(from, path.join(from, relative));
  try {
    const target = path.join(to, relative);
    // Judge an existing copy through its own descriptor; a link never opens.
    const existing = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).then(
      async (handle) => {
        try {
          return await handle.stat();
        } finally {
          await handle.close();
        }
      },
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        if (error.code === "ELOOP") return "link" as const;
        throw error;
      },
    );
    // Never replace a link, directory or device, nor a copy at least as new.
    if (existing === "link" || (existing && (!existing.isFile() || existing.mtimeMs >= source.stat.mtimeMs)))
      return;
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const directory = await ownedTranscriptPath(to, path.dirname(target));
    const temporary = path.join(directory, `.${path.basename(target)}.${randomUUID()}.carry`);
    const output = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const buffer = Buffer.alloc(64 * 1024);
      let offset = 0;
      while (offset < source.stat.size) {
        const { bytesRead } = await source.handle.read(
          buffer, 0, Math.min(buffer.length, source.stat.size - offset), offset,
        );
        if (!bytesRead) throw new Error("History changed while it was being carried");
        let written = 0;
        while (written < bytesRead)
          written += (await output.write(buffer, written, bytesRead - written)).bytesWritten;
        offset += bytesRead;
      }
      // Keep the source time so an unchanged copy is never carried back.
      await output.utimes(source.stat.atime, source.stat.mtime);
      await output.close();
      await rename(temporary, path.join(directory, path.basename(target)));
    } catch (error) {
      await output.close().catch(() => {});
      await rm(temporary, { force: true });
      throw error;
    }
  } finally {
    await source.handle.close();
  }
}

/** Bounded copy of a conversation's sidecar directory. Links are skipped. */
async function carryTree(
  from: string,
  to: string,
  relative: string,
  budget: ScanBudget & { files: number },
  depth = 0,
): Promise<void> {
  if (depth > MAX_SIDECAR_DEPTH) return;
  const directories: string[] = [];
  const files = await directoryNames(from, path.join(from, relative), budget, (entry) => {
    if (entry.isDirectory()) directories.push(entry.name);
    return entry.isFile();
  });
  for (const name of files) {
    if (--budget.files < 0) return;
    await carryFile(from, to, path.join(relative, name));
  }
  for (const name of directories)
    await carryTree(from, to, path.join(relative, name), budget, depth + 1);
}

/** Carry Claude conversation `sessionId` from config root `from` to `to`. */
export async function carryClaudeConversation(opts: {
  from: string;
  to: string;
  sessionId: string;
}): Promise<void> {
  if (!NATIVE_ID.test(opts.sessionId) || path.resolve(opts.from) === path.resolve(opts.to)) return;
  const budget = { remaining: MAX_SCAN_ENTRIES, files: MAX_SIDECAR_FILES };
  const transcript = `${opts.sessionId}.jsonl`;
  // Claude names each project folder after its canonical cwd; the session id
  // is unique, so find it rather than re-deriving Claude's folder encoding.
  for (const project of await directoryNames(
    opts.from, path.join(opts.from, "projects"), budget, (entry) => entry.isDirectory(),
  )) {
    try {
      await carryFile(opts.from, opts.to, path.join("projects", project, transcript));
    } catch (error) {
      // This project folder does not hold the conversation.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    // Subagent transcripts and saved tool output live beside the transcript.
    await carryTree(opts.from, opts.to, path.join("projects", project, opts.sessionId), budget);
    return;
  }
}

/** Carry Codex thread `threadId`'s rollout from home `from` to `to`. */
export async function carryCodexThread(opts: {
  from: string;
  to: string;
  threadId: string;
}): Promise<void> {
  if (!NATIVE_ID.test(opts.threadId) || path.resolve(opts.from) === path.resolve(opts.to)) return;
  const budget = { remaining: MAX_SCAN_ENTRIES };
  const sessions = path.join(opts.from, "sessions");
  const dated = (pattern: RegExp) => (entry: { name: string; isDirectory(): boolean }) =>
    entry.isDirectory() && pattern.test(entry.name);
  const newestFirst = (names: string[]) => names.sort().reverse();
  const rollout = (name: string) =>
    name.startsWith("rollout-") &&
    (name.endsWith(`-${opts.threadId}.jsonl`) || name.endsWith(`-${opts.threadId}.jsonl.zst`));
  // `sessions/YYYY/MM/DD/rollout-<time>-<thread>.jsonl`, the layout Codex
  // falls back to when its state database has no row for the thread.
  for (const year of newestFirst(await directoryNames(opts.from, sessions, budget, dated(/^\d{4}$/)))) {
    for (const month of newestFirst(await directoryNames(
      opts.from, path.join(sessions, year), budget, dated(/^(?:0[1-9]|1[0-2])$/),
    ))) {
      for (const day of newestFirst(await directoryNames(
        opts.from, path.join(sessions, year, month), budget, dated(/^(?:0[1-9]|[12]\d|3[01])$/),
      ))) {
        const names = await directoryNames(
          opts.from, path.join(sessions, year, month, day), budget,
          (entry) => entry.isFile() && rollout(entry.name),
        );
        if (!names.length) continue;
        for (const name of names)
          await carryFile(opts.from, opts.to, path.join("sessions", year, month, day, name));
        return;
      }
    }
  }
}
