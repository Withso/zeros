// ──────────────────────────────────────────────────────────
// IPC commands: agent memory inspector
// ──────────────────────────────────────────────────────────
//
// Surfaces what the agent has remembered about the current project across
// sessions — distinct from the project-context chip, which shows the rules
// files the agent loads at
// startup. Memory is what the agent CAPTURES during use; rules
// are what the user (or repo) WROTE for it.
//
// Per-agent locations:
//
//   Claude    ~/.claude/projects/<cwd-with-slashes-as-dashes>/memory/*
//   Codex     ~/.codex/memories/*
//   Cursor    web-only — return a deepLink instead of files
//
// Read-only. Same NUL-byte preview heuristic as agent-context.ts.
// ──────────────────────────────────────────────────────────

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { currentRoot } from "../../sidecar";
import type { CommandHandler } from "../router";

/** Same containment posture as agent-context.ts — see there for
 *  rationale. Defense-in-depth against a future XSS pivoting through
 *  the IPC into arbitrary file reads. */
function isContained(cwd: string): boolean {
  const home = path.resolve(os.homedir());
  const root = currentRoot();
  const target = path.resolve(cwd);
  if (root) {
    const rootResolved = path.resolve(root);
    if (target === rootResolved || target.startsWith(rootResolved + path.sep)) {
      return true;
    }
  }
  if (target === home || target.startsWith(home + path.sep)) {
    return true;
  }
  return false;
}

interface MemoryFile {
  path: string;
  filename: string;
  size: number;
  mtime: number;
  preview: string;
  /** project-scoped (per-cwd) vs user-global. */
  scope: "project" | "user";
}

interface MemoryResult {
  agentId: string;
  cwd: string | null;
  /** External link for agents whose memory lives server-side
   *  (Cursor today). The renderer surfaces this as "Open Cursor
   *  Memories →" instead of a file list. */
  deepLink?: { label: string; url: string } | null;
  files: MemoryFile[];
  /** Set when the agent has no documented memory location. The
   *  inspector renders an explanatory note rather than an empty
   *  list — empty list reads as "you have no memory" which would
   *  be misleading. */
  unsupported?: boolean;
}

function previewFile(filePath: string): {
  preview: string;
  size: number;
  mtime: number;
} | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(Math.min(stat.size, 1024));
    const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
    let text = buf.subarray(0, bytes).toString("utf-8");
    // Binary-safe heuristic — see agent-context.ts for context.
    if (text.includes("\0")) text = "";
    if (text.length > 400) text = text.slice(0, 400) + "…";
    return { preview: text, size: stat.size, mtime: stat.mtimeMs };
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** List `*.md` files in a directory (non-recursive). */
function listMdInDir(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

/** Claude encodes the project cwd as a directory name by replacing
 *  `/` with `-`. Mirrors the encoding used by the official Claude
 *  Code CLI when it creates `~/.claude/projects/<encoded>/`. */
function encodeClaudeCwd(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

export const agentMemoryFiles: CommandHandler = (args) => {
  const agentId = typeof args.agentId === "string" ? args.agentId : "";
  const cwdArg = typeof args.cwd === "string" ? args.cwd : "";
  // Reject explicit cwd arguments that escape the engine's project
  // root or the user home dir. cwdArg is renderer-supplied; cwd from
  // currentRoot() is engine-supplied so it's trusted.
  if (cwdArg && !isContained(cwdArg)) {
    return {
      agentId,
      cwd: null,
      files: [],
      unsupported: true,
    } as MemoryResult;
  }
  const cwd = cwdArg || currentRoot() || null;
  const home = os.homedir();
  const id = agentId.toLowerCase();

  const result: MemoryResult = {
    agentId,
    cwd,
    files: [],
  };

  if (!agentId) return result;

  const collectAndPush = (filePaths: string[], scope: "project" | "user") => {
    const seen = new Set<string>();
    for (const p of filePaths) {
      if (seen.has(p)) continue;
      seen.add(p);
      const meta = previewFile(p);
      if (!meta) continue;
      result.files.push({
        path: p,
        filename: path.basename(p),
        size: meta.size,
        mtime: meta.mtime,
        preview: meta.preview,
        scope,
      });
    }
  };

  if (id.startsWith("claude")) {
    // Per-project memory: ~/.claude/projects/<encoded>/memory/*.md
    if (cwd) {
      const encoded = encodeClaudeCwd(path.resolve(cwd));
      const memDir = path.join(home, ".claude", "projects", encoded, "memory");
      collectAndPush(listMdInDir(memDir), "project");
    }
    // User-global rules. Strictly speaking this is rules-not-memory
    // territory, but Claude's auto-memory feature writes to MEMORY.md
    // inside the per-project memory dir, and CLAUDE.md is the only
    // user-facing global instruction file — including it gives the
    // user a complete view of "what's persistent for this agent".
    const userClaudeMd = path.join(home, ".claude", "CLAUDE.md");
    collectAndPush([userClaudeMd], "user");
    return result;
  }

  if (id.startsWith("codex") || id.includes("openai")) {
    const memDir = path.join(home, ".codex", "memories");
    collectAndPush(listMdInDir(memDir), "user");
    const userAgentsMd = path.join(home, ".codex", "AGENTS.md");
    collectAndPush([userAgentsMd], "user");
    return result;
  }

  if (id.startsWith("cursor")) {
    // Cursor stores memories server-side; we deep-link out.
    result.deepLink = {
      label: "Open Cursor Memories",
      url: "https://cursor.com/cli/memories",
    };
    return result;
  }

  // Any agent without a documented user-visible memory location
  // surfaces as "unsupported" so the UI explains rather than
  // rendering empty state.
  result.unsupported = true;
  return result;
};
