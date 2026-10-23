// ──────────────────────────────────────────────────────────
// Shell mutation attribution
// ──────────────────────────────────────────────────────────
//
// File-native tools report their paths structurally. Shell tools do not: an
// agent deletion arrives as `{ kind: "execute", rawInput: { command: "rm …" } }`.
// We recover only paths named by well-known mutating commands/redirections, then
// the caller validates those candidates against the turn's real pre/post Git
// snapshots. This is intentionally NOT a general shell interpreter. Unknown
// scripts stay unattributed rather than falling back to a whole-tree diff that
// could steal a concurrent agent's changes.

import * as os from "node:os";
import * as nodePath from "node:path";

export type ShellAuthoredKind = "edit" | "delete" | "renamed";

export interface ShellAuthoredPath {
  path: string;
  kind: ShellAuthoredKind;
}

const CONTROL = new Set([";", "&&", "||", "|"]);
const OUTPUT_REDIRECT = new Set([">", ">>", ">|"]);
const INPUT_REDIRECT = new Set(["<", "<<"]);

/** Small quote-aware lexer sufficient for command/argument boundaries. */
function shellTokens(command: string): string[] {
  const out: string[] = [];
  let token = "";
  let quote: "single" | "double" | null = null;
  let escaped = false;
  const flush = () => {
    if (token.length > 0) out.push(token);
    token = "";
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (escaped) {
      token += ch;
      escaped = false;
      continue;
    }
    if (quote === "single") {
      if (ch === "'") quote = null;
      else token += ch;
      continue;
    }
    if (quote === "double") {
      if (ch === '"') quote = null;
      else if (ch === "\\") escaped = true;
      else token += ch;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "'") {
      quote = "single";
      continue;
    }
    if (ch === '"') {
      quote = "double";
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      if (ch === "\n") out.push(";");
      continue;
    }
    if (ch === "&" && command[i + 1] === "&") {
      flush();
      out.push("&&");
      i += 1;
      continue;
    }
    if (ch === "|" && command[i + 1] === "|") {
      flush();
      out.push("||");
      i += 1;
      continue;
    }
    if (ch === ">" && command[i + 1] === ">") {
      flush();
      out.push(">>");
      i += 1;
      continue;
    }
    if (ch === ">" && command[i + 1] === "|") {
      flush();
      out.push(">|");
      i += 1;
      continue;
    }
    if (ch === "<" && command[i + 1] === "<") {
      flush();
      out.push("<<");
      i += 1;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === ">" || ch === "<") {
      flush();
      out.push(ch);
      continue;
    }
    token += ch;
  }
  if (escaped) token += "\\";
  flush();
  return out;
}

function commandName(raw: string): string {
  return nodePath.basename(raw.replace(/^\(+/, "").replace(/\)+$/, ""));
}

function isAssignment(raw: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(raw);
}

function usablePathArg(raw: string): boolean {
  return (
    raw.length > 0 &&
    raw !== "-" &&
    !/^&\d+$/.test(raw) &&
    !/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) &&
    !raw.includes("$(") &&
    !raw.includes("${") &&
    !raw.includes("\0")
  );
}

/** Drop flags but retain arguments after `--` (including `-named` files). */
function pathArgs(args: string[]): string[] {
  const out: string[] = [];
  let literal = false;
  for (const arg of args) {
    if (!literal && arg === "--") {
      literal = true;
      continue;
    }
    if (!literal && arg.startsWith("-")) continue;
    if (usablePathArg(arg)) out.push(arg);
  }
  return out;
}

function pathsAfterDoubleDash(args: string[]): string[] {
  const i = args.indexOf("--");
  return i >= 0 ? args.slice(i + 1).filter(usablePathArg) : [];
}

function resolveBase(fromDir: string, requestedCwd: unknown): string {
  if (typeof requestedCwd !== "string" || requestedCwd.length === 0) {
    return fromDir;
  }
  return nodePath.isAbsolute(requestedCwd)
    ? requestedCwd
    : nodePath.resolve(fromDir, requestedCwd);
}

function relativeToRoot(
  base: string,
  root: string,
  raw: string,
): string | null {
  if (!usablePathArg(raw) || raw.includes("$") || raw.includes("`"))
    return null;
  const expanded =
    raw === "~"
      ? os.homedir()
      : raw.startsWith("~/")
        ? nodePath.join(os.homedir(), raw.slice(2))
        : raw;
  const abs = nodePath.isAbsolute(expanded)
    ? nodePath.normalize(expanded)
    : nodePath.resolve(base, expanded);
  const rel = nodePath.relative(root, abs);
  if (rel.startsWith("..") || nodePath.isAbsolute(rel)) return null;
  // The worktree root itself (`git restore .`, `cp -r x .`, …) would become a
  // whole-tree pathspec downstream and attribute concurrent agents' changes to
  // this turn — the exact fallback this module refuses. Named files only;
  // root-targeting commands stay unattributed.
  if (!rel) return null;
  return rel.split(nodePath.sep).join("/");
}

interface Candidate {
  raw: string;
  base: string;
  kind: ShellAuthoredKind;
}

/** Recover paths from the patch helper's structured begin/end grammar. */
function applyPatchBodyCandidates(source: string, base: string): Candidate[] {
  const begin = source.indexOf("*** Begin Patch");
  const end = source.indexOf("*** End Patch", begin + 1);
  if (begin < 0 || end < 0) return [];

  const candidates: Candidate[] = [];
  let lastUpdate: Candidate | null = null;
  const body = source.slice(begin, end);
  for (const line of body.split(/\r?\n/)) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (header) {
      const operation = header[1];
      const raw = header[2].trim();
      if (!usablePathArg(raw)) {
        lastUpdate = null;
        continue;
      }
      const candidate: Candidate = {
        raw,
        base,
        kind: operation === "Delete" ? "delete" : "edit",
      };
      candidates.push(candidate);
      lastUpdate = operation === "Update" ? candidate : null;
      continue;
    }
    const move = /^\*\*\* Move to: (.+)$/.exec(line);
    if (move && lastUpdate) {
      lastUpdate.kind = "renamed";
      const raw = move[1].trim();
      if (usablePathArg(raw)) {
        candidates.push({ raw, base, kind: "renamed" });
      }
    }
  }
  return candidates;
}

/** Agents use this fallback when their native edit tool is unavailable, so the
 * outer tool is a shell execution even though the operation is file-native.
 * Require both a heredoc invocation and the begin/end sentinels: merely
 * printing or discussing a patch must not claim another turn's file. */
function inlineApplyPatchCandidates(
  command: string,
  base: string,
): Candidate[] {
  const begin = command.indexOf("*** Begin Patch");
  if (begin < 0) return [];
  const invocation = command.slice(0, begin);
  if (!/\bapply_patch\s*<<-?/.test(invocation)) return [];
  return applyPatchBodyCandidates(command, base);
}

function invokesApplyPatchOnStdin(command: string): boolean {
  const tokens = shellTokens(command).filter((token) => token !== ";");
  if (tokens.length === 1) return commandName(tokens[0]) === "apply_patch";
  return (
    tokens.length === 3 &&
    ["sh", "bash", "zsh"].includes(commandName(tokens[0])) &&
    ["-c", "-lc"].includes(tokens[1]) &&
    commandName(tokens[2]) === "apply_patch"
  );
}

function shellOutputText(rawOutput: unknown): string | null {
  if (typeof rawOutput === "string") return rawOutput;
  if (!rawOutput || typeof rawOutput !== "object") return null;
  const output = (rawOutput as Record<string, unknown>).output;
  return typeof output === "string" ? output : null;
}

interface GitPatchSection {
  oldPath: string | null;
  newPath: string | null;
  newIsNull: boolean;
  renamed: boolean;
}

function gitHeaderPath(raw: string, prefix = ""): string | null {
  const trimmed = raw.trim();
  const quoted = trimmed.startsWith('"') || trimmed.startsWith("'");
  const tokens = quoted
    ? shellTokens(trimmed).filter((token) => token !== ";")
    : [trimmed];
  if (tokens.length !== 1 || tokens[0] === "/dev/null") return null;
  const value = tokens[0];
  if (prefix && !value.startsWith(prefix)) return null;
  return prefix ? value.slice(prefix.length) : value;
}

/** Recover paths from an inline unified diff passed to `git apply`. Codex can
 * choose this route instead of its native fileChange/apply_patch tools. The
 * heredoc requirement keeps prose, echoed examples, and ordinary `git diff`
 * output from claiming files; finishTurn still intersects every candidate with
 * the real pre/post tree delta. */
function inlineGitApplyCandidates(command: string, base: string): Candidate[] {
  const firstDiff = command.search(/^diff --git /m);
  if (firstDiff < 0) return [];
  const invocation = command.slice(0, firstDiff).trimEnd();
  if (
    !/\bgit\s+apply\b[^\n]*<<-?\s*['"]?[A-Za-z0-9_]+['"]?\s*$/.test(invocation)
  ) {
    return [];
  }

  const candidates: Candidate[] = [];
  let section: GitPatchSection | null = null;
  const finish = () => {
    if (!section) return;
    if (section.newIsNull) {
      if (section.oldPath) {
        candidates.push({ raw: section.oldPath, base, kind: "delete" });
      }
    } else if (section.renamed) {
      if (section.oldPath) {
        candidates.push({ raw: section.oldPath, base, kind: "renamed" });
      }
      if (section.newPath) {
        candidates.push({ raw: section.newPath, base, kind: "renamed" });
      }
    } else if (section.newPath) {
      candidates.push({ raw: section.newPath, base, kind: "edit" });
    }
    section = null;
  };

  for (const line of command.slice(firstDiff).split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      finish();
      const paths = shellTokens(line.slice("diff --git ".length));
      if (paths.length !== 2) continue;
      section = {
        oldPath: gitHeaderPath(paths[0], "a/"),
        newPath: gitHeaderPath(paths[1], "b/"),
        newIsNull: false,
        renamed: false,
      };
      continue;
    }
    if (!section) continue;
    if (line.startsWith("--- ")) {
      const path = gitHeaderPath(line.slice(4), "a/");
      if (path) section.oldPath = path;
    } else if (line.startsWith("+++ ")) {
      section.newIsNull = line.slice(4).trim() === "/dev/null";
      const path = gitHeaderPath(line.slice(4), "b/");
      if (path) section.newPath = path;
    } else if (line.startsWith("rename from ")) {
      section.renamed = true;
      section.oldPath = gitHeaderPath(line.slice("rename from ".length));
    } else if (line.startsWith("rename to ")) {
      section.renamed = true;
      section.newPath = gitHeaderPath(line.slice("rename to ".length));
    } else if (line.startsWith("copy from ")) {
      section.oldPath = gitHeaderPath(line.slice("copy from ".length));
    } else if (line.startsWith("copy to ")) {
      section.newPath = gitHeaderPath(line.slice("copy to ".length));
    }
  }
  finish();
  return candidates;
}

/** Paths explicitly targeted by one simple shell command. */
function commandCandidates(
  tokens: string[],
  base: string,
): {
  candidates: Candidate[];
  nextBase?: string;
} {
  const candidates: Candidate[] = [];
  const plain: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (OUTPUT_REDIRECT.has(token)) {
      const target = tokens[i + 1];
      if (target && usablePathArg(target)) {
        candidates.push({ raw: target, base, kind: "edit" });
      }
      i += 1;
      continue;
    }
    if (INPUT_REDIRECT.has(token)) {
      i += 1;
      continue;
    }
    plain.push(token);
  }

  let index = 0;
  while (index < plain.length && isAssignment(plain[index])) index += 1;
  // Common wrappers. Options/assignments that follow `sudo`/`env` are skipped;
  // any misclassified value is harmless because the Git diff validates paths.
  while (index < plain.length) {
    const wrapper = commandName(plain[index]);
    if (!["sudo", "env", "command", "builtin", "nohup"].includes(wrapper)) {
      break;
    }
    index += 1;
    while (
      index < plain.length &&
      (plain[index].startsWith("-") || isAssignment(plain[index]))
    ) {
      index += 1;
    }
  }
  if (index >= plain.length) return { candidates };

  const executable = commandName(plain[index]);
  const args = plain.slice(index + 1);
  if (executable === "cd" || executable === "pushd") {
    const target = pathArgs(args)[0];
    return {
      candidates,
      nextBase: target
        ? nodePath.resolve(
            base,
            target === "~"
              ? os.homedir()
              : target.startsWith("~/")
                ? nodePath.join(os.homedir(), target.slice(2))
                : target,
          )
        : base,
    };
  }

  const add = (raws: string[], kind: ShellAuthoredKind) => {
    for (const raw of raws) candidates.push({ raw, base, kind });
  };
  if (["rm", "unlink", "shred"].includes(executable)) {
    add(pathArgs(args), "delete");
  } else if (["mv", "rename"].includes(executable)) {
    add(pathArgs(args), "renamed");
  } else if (
    [
      "cp",
      "install",
      "touch",
      "truncate",
      "tee",
      "rsync",
      "ln",
      "chmod",
      "chown",
      "chgrp",
    ].includes(executable)
  ) {
    add(pathArgs(args), "edit");
  } else if (
    executable === "sed" &&
    args.some((arg) => /^-[^-]*i/.test(arg) || arg === "--in-place")
  ) {
    add(pathArgs(args), "edit");
  } else if (
    executable === "perl" &&
    args.some((arg) => /^-[^-]*i/.test(arg) || arg === "--in-place")
  ) {
    add(pathArgs(args), "edit");
  } else if (executable === "dd") {
    add(
      args
        .filter((arg) => arg.startsWith("of="))
        .map((arg) => arg.slice(3))
        .filter(usablePathArg),
      "edit",
    );
  } else if (executable === "git") {
    let subIndex = 0;
    while (subIndex < args.length && args[subIndex].startsWith("-")) {
      subIndex += 1;
    }
    const sub = args[subIndex] ?? "";
    const subArgs = args.slice(subIndex + 1);
    if (sub === "rm") add(pathArgs(subArgs), "delete");
    else if (sub === "mv") add(pathArgs(subArgs), "renamed");
    else if (sub === "restore" || sub === "clean") {
      add(pathArgs(subArgs), sub === "clean" ? "delete" : "edit");
    } else if (sub === "checkout" || sub === "reset") {
      add(pathsAfterDoubleDash(subArgs), "edit");
    }
  }
  return { candidates };
}

/**
 * Recover candidate authored paths from a shell tool. Candidates remain scoped
 * to the named command and are later intersected with the real snapshot diff;
 * a denied/no-op command therefore records nothing.
 */
export function authoredPathsFromShellCommand(
  command: string,
  fromDir: string,
  root: string,
  requestedCwd?: unknown,
  rawOutput?: unknown,
): ShellAuthoredPath[] {
  if (!command.trim()) return [];
  let base = resolveBase(fromDir, requestedCwd);
  const byPath = new Map<string, ShellAuthoredKind>();
  for (const candidate of inlineApplyPatchCandidates(command, base)) {
    const path = relativeToRoot(candidate.base, root, candidate.raw);
    if (path) byPath.set(path, candidate.kind);
  }
  for (const candidate of inlineGitApplyCandidates(command, base)) {
    const path = relativeToRoot(candidate.base, root, candidate.raw);
    if (path) byPath.set(path, candidate.kind);
  }
  const output = shellOutputText(rawOutput);
  if (output && invokesApplyPatchOnStdin(command)) {
    for (const candidate of applyPatchBodyCandidates(output, base)) {
      const path = relativeToRoot(candidate.base, root, candidate.raw);
      if (path) byPath.set(path, candidate.kind);
    }
  }
  let segment: string[] = [];
  const flush = () => {
    if (segment.length === 0) return;
    const parsed = commandCandidates(segment, base);
    for (const candidate of parsed.candidates) {
      const path = relativeToRoot(candidate.base, root, candidate.raw);
      if (path) byPath.set(path, candidate.kind);
    }
    if (parsed.nextBase) base = parsed.nextBase;
    segment = [];
  };

  for (const token of shellTokens(command)) {
    if (CONTROL.has(token)) flush();
    else segment.push(token);
  }
  flush();
  return [...byPath.entries()].map(([path, kind]) => ({ path, kind }));
}
