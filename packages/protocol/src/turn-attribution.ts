// Local and cloud intersect these per-turn candidates with Git snapshot differences before recording changes.
import * as nodePath from "node:path";
import type { AgentMessage, AgentToolMessage } from "./agent-messages";
import { authoredPathsFromShellCommand } from "./shell-authored-paths";

export interface AuthoredPath {
  path: string;
  kind: "edit" | "delete" | "renamed";
}

/** Resolve tool paths against the agent cwd but report them relative to the worktree snapshots. */
function relTo(fromDir: string, root: string, raw: string): string | null {
  if (!raw) return null;
  const abs = nodePath.isAbsolute(raw) ? raw : nodePath.resolve(fromDir, raw);
  const rel = nodePath.relative(root, abs);
  // Never attribute a path outside the worktree.
  if (rel.startsWith("..") || nodePath.isAbsolute(rel)) return null;
  return rel.split(nodePath.sep).join("/");
}

export function pathsFromTool(
  fromDir: string,
  root: string,
  t: AgentToolMessage,
): string[] {
  const out: string[] = [];
  const push = (raw: unknown): void => {
    if (typeof raw !== "string" || !raw) return;
    const rel = relTo(fromDir, root, raw);
    if (rel && !out.includes(rel)) out.push(rel);
  };
  // ACP locations are the primary cross-adapter path evidence.
  const locs = t.locations as Array<{ path?: string }> | undefined;
  if (Array.isArray(locs)) for (const l of locs) push(l?.path);
  const ri = t.rawInput as Record<string, unknown> | undefined;
  if (ri && typeof ri === "object") {
    const keys = [
      "file_path",
      "filePath",
      "path",
      "abs_path",
      "absolute_path",
      "notebook_path",
      "target_file",
      "new_path",
      "old_path",
    ];
    for (const k of keys) push(ri[k]);
    // Read nested arrays for multi-file Codex changes and Cursor diffs.
    for (const key of ["changes", "edits", "files"] as const) {
      const arr = ri[key];
      if (Array.isArray(arr)) {
        for (const c of arr) {
          if (c && typeof c === "object") {
            const rec = c as Record<string, unknown>;
            push(rec.path ?? rec.file_path ?? rec.filePath ?? rec.new_path);
          } else {
            push(c);
          }
        }
      }
    }
  }
  return out;
}

/** Attribute only this turn's tool stream, with the last operation winning for each path. */
export function authoredPathsFromMessages(
  messages: AgentMessage[],
  fromDir: string,
  root: string = fromDir,
): AuthoredPath[] {
  const byPath = new Map<string, AuthoredPath["kind"]>();
  for (const m of messages) {
    if (m.kind !== "tool") continue;
    const t = m as AgentToolMessage;
    if (t.status === "pending") continue;
    const kindRaw = (t.toolKind ?? "").toLowerCase();
    // Shell tools supply candidates from known mutations; Git snapshots confirm whether anything changed.
    if (kindRaw === "execute" || kindRaw === "bash" || kindRaw === "shell") {
      const input =
        t.rawInput && typeof t.rawInput === "object"
          ? (t.rawInput as Record<string, unknown>)
          : null;
      const command = input?.command;
      if (typeof command === "string") {
        for (const authored of authoredPathsFromShellCommand(
          command,
          fromDir,
          root,
          input?.cwd,
          t.rawOutput,
        )) {
          byPath.set(authored.path, authored.kind);
        }
      }
      continue;
    }
    // Skip failed file tools to avoid attributing external edits; failed shell commands can still mutate before exit.
    if (t.status === "failed") continue;
    let kind: AuthoredPath["kind"] | null = null;
    if (kindRaw === "edit" || kindRaw === "write") kind = "edit";
    else if (kindRaw === "delete") kind = "delete";
    else if (kindRaw === "move" || kindRaw === "rename") kind = "renamed";
    if (!kind) continue;
    for (const path of pathsFromTool(fromDir, root, t)) byPath.set(path, kind);
  }
  return [...byPath.entries()].map(([path, kind]) => ({ path, kind }));
}

const SHELL_KINDS = new Set(["execute", "bash", "shell"]);
const MAX_SCANNED_OUTPUT = 256 * 1024;
const MAX_TURN_COMMITS = 100;
// Git uses different summary prefixes for root commits and detached HEAD.
const COMMIT_SUMMARY = /^\[(?:detached HEAD|[^\s\]]+)(?: \(root-commit\))? ([0-9a-f]{7,40})\] \S/gm;

function shellOutputTexts(t: AgentToolMessage): string[] {
  const texts: string[] = [];
  const raw = t.rawOutput;
  if (typeof raw === "string") texts.push(raw);
  else if (raw && typeof raw === "object") {
    for (const key of ["output", "stdout", "aggregatedOutput", "formatted_output"]) {
      const value = (raw as Record<string, unknown>)[key];
      if (typeof value === "string") texts.push(value);
    }
  }
  for (const item of t.content ?? []) {
    if (item?.type === "content" && item.content?.type === "text") texts.push(item.content.text);
  }
  return texts.map((text) => text.slice(0, MAX_SCANNED_OUTPUT));
}

/** Shell reports are candidates until the caller resolves them to commit objects; a command can commit before failing. */
export function commitShasFromMessages(messages: AgentMessage[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (m.kind !== "tool") continue;
    const t = m as AgentToolMessage;
    if (t.status === "pending" || !SHELL_KINDS.has((t.toolKind ?? "").toLowerCase())) continue;
    const command = (t.rawInput as Record<string, unknown> | undefined)?.command;
    if (typeof command !== "string" || !/\bgit\b/.test(command)) continue;
    for (const text of shellOutputTexts(t)) {
      for (const match of text.matchAll(COMMIT_SUMMARY)) {
        if (!out.includes(match[1]!)) out.push(match[1]!);
        if (out.length >= MAX_TURN_COMMITS) return out;
      }
    }
  }
  return out;
}

export { authoredPathsFromShellCommand, type ShellAuthoredKind, type ShellAuthoredPath } from "./shell-authored-paths";
