// Pure tool-to-path attribution shared by the Local engine and cloud worker.
// Candidates become changes only after comparison with real Git snapshots.
import * as nodePath from "node:path";
import type { AgentMessage, AgentToolMessage } from "./agent-messages";
import { authoredPathsFromShellCommand } from "./shell-authored-paths";

export interface AuthoredPath {
  path: string;
  kind: "edit" | "delete" | "renamed";
}

/** Resolve a tool's reported path (relative to the agent cwd `fromDir`, or
 *  absolute) and express it relative to the worktree `root` — the frame every
 *  snapshot/diff/reset uses. When `fromDir === root` (the chat folder IS the
 *  worktree top, the common case) this is the old single-cwd behavior. */
function relTo(fromDir: string, root: string, raw: string): string | null {
  if (!raw) return null;
  const abs = nodePath.isAbsolute(raw) ? raw : nodePath.resolve(fromDir, raw);
  const rel = nodePath.relative(root, abs);
  // Reject paths that escape the work tree (defensive — never restore outside).
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
  // Priority 1: ACP `locations` (most reliable, cross-adapter).
  const locs = t.locations as Array<{ path?: string }> | undefined;
  if (Array.isArray(locs)) for (const l of locs) push(l?.path);
  // Priority 2: common rawInput shapes across Claude / Codex / Cursor tools.
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
    // Codex's `fileChange` tool nests one-or-MORE paths under
    // `rawInput.changes: [{ path }]` (app-server-translator toolInput) and sets
    // no scalar key / no `locations` — so without this branch a Codex edit
    // attributes to NOTHING and the turn records 0 files. Cursor's apply-diff
    // shapes that surface an `edits`/`files` array land here too.
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

/** The set of files THIS turn's agent edited/deleted/renamed, from its own tool
 *  calls. Concurrency-immune (another chat's tool calls are in another session's
 *  message stream). Dedupes by path, last-writer-wins on kind. A single tool
 *  call may touch several files (e.g. Codex's multi-file patch), so each path it
 *  names is attributed. */
export function authoredPathsFromMessages(
  messages: AgentMessage[],
  fromDir: string,
  root: string = fromDir,
): AuthoredPath[] {
  const byPath = new Map<string, AuthoredPath["kind"]>();
  for (const m of messages) {
    if (m.kind !== "tool") continue;
    const t = m as AgentToolMessage;
    // A tool that never progressed past pending didn't change anything.
    if (t.status === "pending") continue;
    const kindRaw = (t.toolKind ?? "").toLowerCase();
    // Shell mutations (notably `rm`) arrive as generic execute tools rather
    // than file tools. Recover only paths explicitly named by known mutating
    // commands/redirections; finishTurn intersects them with the real snapshot
    // diff, so denied and no-op commands still produce no recorded file.
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
    // File-native tools are atomic from the adapter's perspective. A failed
    // Write/Edit/Delete is a denial or rejected operation, not authorship. Drop
    // it before path attribution so an unrelated external edit to the same path
    // during the prompt cannot be mistaken for the denied proposal. (Failed
    // shell commands stay above: a shell may mutate before exiting non-zero.)
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


export { authoredPathsFromShellCommand, type ShellAuthoredKind, type ShellAuthoredPath } from "./shell-authored-paths";
