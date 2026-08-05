// ──────────────────────────────────────────────────────────
// IPC commands: agent project-context discovery
// ──────────────────────────────────────────────────────────
//
// Walks the cwd → parents → home directory looking
// for the context files each agent loads at startup (CLAUDE.md,
// AGENTS.md, .cursor/rules/*.md, etc.) and returns a
// flat list with metadata + a short preview the chat-header chip
// can render directly.
//
// Read-only. We never write or mutate. Containment: paths are
// only ever resolved off cwd or off the user's home dir, never
// arbitrary input.
// ──────────────────────────────────────────────────────────

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { currentRoot } from "../../sidecar";
import type { CommandHandler } from "../router";

/** Reject `cwd` arguments that escape the engine's project root. The
 *  bridge is renderer-trusted today, but defense in depth: an XSS
 *  bypass through the markdown renderer (or a future bug) shouldn't
 *  promote itself into an arbitrary-fs-read primitive via this IPC.
 *
 *  Allowed roots: the engine's currentRoot() and the user's home dir
 *  (so the rules-file walker can still climb into ~/.claude/CLAUDE.md
 *  and similar). Anything else is rejected. */
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

interface ContextFile {
  path: string;
  filename: string;
  size: number;
  mtime: number;
  preview: string;
  scope: "project" | "parent" | "user";
}

interface ContextResult {
  agentId: string;
  cwd: string;
  files: ContextFile[];
}

/** Truncated head of the file as a single string, about 200 characters,
 *  with newlines preserved so the popover can render
 *  the first paragraph cleanly. Binary files (rare for .md) get an
 *  empty preview rather than a garbled byte string. */
function previewFile(
  filePath: string,
): { preview: string; size: number; mtime: number } | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(Math.min(stat.size, 512));
    const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
    let text = buf.subarray(0, bytes).toString("utf-8");
    // Binary-safe heuristic: a NUL byte in the head is a strong
    // signal the file isn't text — drop the preview rather than
    // serving garbled bytes to the popover.
    if (text.includes("\0")) text = "";
    if (text.length > 200) text = text.slice(0, 200) + "…";
    return { preview: text, size: stat.size, mtime: stat.mtimeMs };
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** The set of context-file names each agent loads. The renderer's
 *  agent-ui-registry knows the same
 *  facts (rulesFileName); we duplicate here to keep the IPC handler
 *  self-contained — agent ids cross the bridge as plain strings, no
 *  registry lookup possible main-side. */
function rulesFileNamesForAgent(agentId: string): string[] {
  const id = agentId.toLowerCase();
  if (id.startsWith("claude")) return ["CLAUDE.md"];
  if (id.startsWith("codex") || id.includes("openai")) return ["AGENTS.md"];
  if (id.startsWith("cursor")) return ["AGENTS.md", "CLAUDE.md"];
  return ["AGENTS.md"];
}

/** Per-agent home-dir global file (one per agent). Returns null if
 *  the agent doesn't define a global rules file. */
function userGlobalRulesPath(agentId: string): string | null {
  const id = agentId.toLowerCase();
  const home = os.homedir();
  if (id.startsWith("claude")) return path.join(home, ".claude", "CLAUDE.md");
  if (id.startsWith("codex") || id.includes("openai"))
    return path.join(home, ".codex", "AGENTS.md");
  return null;
}

/** Per-agent additional rules directories (.claude/rules/*, .cursor/
 *  rules/*). Each path is a directory; we glob *.md inside, non-
 *  recursive. Empty list when the agent doesn't define one. */
function rulesDirNamesForAgent(agentId: string): string[] {
  const id = agentId.toLowerCase();
  if (id.startsWith("claude")) return [".claude/rules"];
  if (id.startsWith("cursor")) return [".cursor/rules"];
  return [];
}

/** Walk dir → parent → … → fs root collecting matches. */
function walkUpForFile(startDir: string, filenames: string[]): string[] {
  const out: string[] = [];
  let dir = path.resolve(startDir);
  // Hard cap so a pathological cwd (root-only) doesn't infinite-loop.
  for (let depth = 0; depth < 32; depth++) {
    for (const name of filenames) {
      const candidate = path.join(dir, name);
      try {
        if (fs.statSync(candidate).isFile()) {
          out.push(candidate);
        }
      } catch {
        /* doesn't exist */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

/** Glob `*.md` in a single directory (non-recursive). Used for the
 *  `.claude/rules/` and `.cursor/rules/` dirs. */
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

export const agentContextFiles: CommandHandler = (args) => {
  const cwd = typeof args.cwd === "string" ? args.cwd : "";
  const agentId = typeof args.agentId === "string" ? args.agentId : "";
  if (!cwd || !agentId) {
    return { agentId, cwd, files: [] } as ContextResult;
  }
  if (!isContained(cwd)) {
    // Out-of-tree cwd — refuse rather than silently scan / leak. The
    // empty result mirrors the "no agent / no cwd" path so the chip
    // hides itself, no UX regression for the legit case.
    return { agentId, cwd, files: [] } as ContextResult;
  }

  const ruleNames = rulesFileNamesForAgent(agentId);
  const userGlobal = userGlobalRulesPath(agentId);
  const rulesDirs = rulesDirNamesForAgent(agentId);

  // 1. cwd → parents
  const inTreePaths = walkUpForFile(cwd, ruleNames);

  // 2. rules dirs (project + parents)
  const dirPaths: string[] = [];
  let dir = path.resolve(cwd);
  for (let depth = 0; depth < 32; depth++) {
    for (const rel of rulesDirs) {
      dirPaths.push(...listMdInDir(path.join(dir, rel)));
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // 3. user-global file
  const globals: string[] = [];
  if (userGlobal) {
    try {
      if (fs.statSync(userGlobal).isFile()) globals.push(userGlobal);
    } catch {
      /* no global file */
    }
  }

  const cwdResolved = path.resolve(cwd);
  const home = os.homedir();
  const seen = new Set<string>();
  const files: ContextFile[] = [];
  const collect = (
    paths: string[],
    fallbackScope: "project" | "parent" | "user",
  ): void => {
    for (const p of paths) {
      if (seen.has(p)) continue;
      seen.add(p);
      const meta = previewFile(p);
      if (!meta) continue;
      const scope =
        p.startsWith(home) && !p.startsWith(cwdResolved + path.sep)
          ? "user"
          : p.startsWith(cwdResolved + path.sep) || p === cwdResolved
            ? "project"
            : fallbackScope;
      files.push({
        path: p,
        filename: path.basename(p),
        size: meta.size,
        mtime: meta.mtime,
        preview: meta.preview,
        scope,
      });
    }
  };
  collect(inTreePaths, "parent");
  collect(dirPaths, "project");
  collect(globals, "user");

  return { agentId, cwd, files } as ContextResult;
};
