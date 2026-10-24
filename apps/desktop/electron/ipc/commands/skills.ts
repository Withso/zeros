// ──────────────────────────────────────────────────────────
// IPC commands: skills
// ──────────────────────────────────────────────────────────
//
// Reads the agent's on-disk SKILL library so the composer can show skills
// in the "/" picker INSTANTLY (a fast local fs scan, no agent session) —
// instead of waiting for the agent's own discovery, which is late for Claude
// (lazy query → first turn only), a round-trip for Codex (`skills/list`), and
// nonexistent for Cursor (no skills API). The list is unioned into the picker
// (agent-reported entries win on a name clash; see use-composer-editor).
//
// Skills follow the per-agent directory convention `~/.<agent>/skills/<name>/
// SKILL.md` (and the workspace-level `.<agent>/skills/`), each with frontmatter:
//   ---
//   name: wrangler              # falls back to the directory name
//   description: One-line summary
//   icon: LucideIconName        # optional; defaults to "Sparkles"
//   ---
//   <body>
// A flat `<root>/<name>.md` file is also accepted (the older convention).
// ──────────────────────────────────────────────────────────

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { currentRoot } from "../../sidecar";
import type { CommandHandler } from "../router";

interface SkillPayload {
  id: string;
  name: string;
  description: string;
  icon: string;
  body: string;
  path: string;
  content: string;
}

/** Split `--- <yaml> ---\n<body>` into a flat key→value map and the
 *  rest of the file. Only top-level `key: value` lines are parsed on
 *  the yaml side; everything after the closing `---` (and one leading
 *  newline) is treated as body. */
function splitFrontmatter(raw: string): { fm: Map<string, string>; body: string } {
  const fm = new Map<string, string>();
  const trimmed = raw.replace(/^\s+/, "");
  if (!trimmed.startsWith("---")) return { fm, body: raw };

  const firstNewline = trimmed.indexOf("\n");
  if (firstNewline < 0) return { fm, body: raw };
  const afterOpen = trimmed.slice(firstNewline + 1);

  const closingIdx = afterOpen.indexOf("\n---");
  if (closingIdx < 0) return { fm, body: raw };

  const fmText = afterOpen.slice(0, closingIdx);
  for (const line of fmText.split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key) fm.set(key, value);
  }

  let body = afterOpen.slice(closingIdx + "\n---".length);
  // Strip a single leading newline after the closing delimiter,
  // Trim leading blank lines so markdown descriptions render cleanly.
  if (body.startsWith("\n")) body = body.slice(1);
  return { fm, body };
}

/** Per-agent skill-directory hierarchy, in precedence order (workspace
 *  overrides user-home). Mirrors how each agent itself resolves skills:
 *  Claude `~/.claude/skills`, Codex `$CODEX_HOME/skills`, Cursor
 *  `~/.cursor/skills`. A project-level `<cwd>/skills` is always included as a
 *  cross-agent convention. Missing dirs are simply skipped by the scanner. */
interface SkillRoot { owner: string; path: string }
function resolveSkillRoots(agentId: string | null, cwd: string | null): SkillRoot[] {
  const home = os.homedir();
  const provider = ["claude", "codex", "cursor"].includes(agentId ?? "") ? agentId! : "claude";
  const providerHome = provider === "codex"
    ? process.env.CODEX_HOME?.trim() || path.join(home, ".codex")
    : path.join(home, `.${provider}`);
  return [
    ...(cwd ? [
      { owner: cwd, path: path.join(cwd, `.${provider}`, "skills") },
      { owner: cwd, path: path.join(cwd, ".agents", "skills") },
      { owner: cwd, path: path.join(cwd, "skills") },
    ] : []),
    { owner: providerHome, path: path.join(providerHome, "skills") },
    ...(provider === "codex" ? [{ owner: providerHome, path: path.join(providerHome, "skills", ".system") }] : []),
    { owner: home, path: path.join(home, ".agents", "skills") },
  ];
}

const MAX_SKILL_BYTES = 256 * 1024;
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
function contained(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel) && !rel.split(path.sep).includes(".git");
}

/** The held descriptor and identity checks bound reads even if a repository
 * changes during discovery. A source preview cannot widen the library root. */
function readSkill(file: string, root: string): string | null {
  let fd: number | undefined;
  try {
    const resolved = fs.realpathSync(file);
    if (!contained(root, resolved)) return null;
    fd = fs.openSync(resolved, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const held = fs.fstatSync(fd);
    if (!held.isFile() || held.size > MAX_SKILL_BYTES) return null;
    // Validate the opened file, including a parent replaced at open. Looking
    // up its type/size before opening can describe a different directory entry.
    const openedPath = fs.realpathSync(file);
    if (!contained(root, openedPath)) return null;
    const current = fs.statSync(openedPath);
    if (current.dev !== held.dev || current.ino !== held.ino) return null;
    const bytes = Buffer.alloc(MAX_SKILL_BYTES + 1);
    const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
    const finalPath = fs.realpathSync(file);
    if (length > MAX_SKILL_BYTES || !contained(root, finalPath)) return null;
    const after = fs.statSync(finalPath);
    if (after.dev !== held.dev || after.ino !== held.ino) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
  } catch { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** Earlier roots win; all project conventions precede home libraries. */
function scanSkillRoot(root: SkillRoot, byName: Map<string, SkillPayload>, budget: { bytes: number }): void {
  let directory: string, entries: fs.Dirent[];
  try {
    directory = fs.realpathSync(root.path);
    if (!contained(fs.realpathSync(root.owner), directory)) return;
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch { return; }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries.slice(0, 512)) {
    if (byName.size >= 256) break;
    const id = entry.isDirectory() ? entry.name : entry.name.replace(/\.md$/i, "");
    const file = entry.isDirectory() ? path.join(directory, entry.name, "SKILL.md")
      : entry.isFile() && /\.md$/i.test(entry.name) ? path.join(directory, entry.name) : null;
    if (!file) continue;
    const raw = readSkill(file, directory);
    if (raw === null) continue;
    const { fm, body } = splitFrontmatter(raw);
    const unquote = (value: string | undefined) => value?.replace(/^(['"])(.*)\1$/, "$2");
    const name = unquote(fm.get("name")) || id;
    if (byName.has(name)) continue;
    const skill: SkillPayload = {
      id, name, description: unquote(fm.get("description")) ?? "",
      icon: unquote(fm.get("icon")) ?? "Sparkles", body, path: file, content: raw,
    };
    const size = Buffer.byteLength(JSON.stringify(skill)) + 1;
    if (budget.bytes + size > MAX_CATALOG_BYTES) continue;
    budget.bytes += size;
    byName.set(name, skill);
  }
}

export const skillsList: CommandHandler = (args) => {
  // The composer passes the active chat's cwd + agentId so each agent reads
  // ITS skill dirs from the right workspace. Both optional; home-dir roots are
  // scanned regardless of cwd.
  const a = (args ?? {}) as { cwd?: unknown; agentId?: unknown };
  const cwd =
    typeof a.cwd === "string" && a.cwd ? a.cwd : currentRoot() || null;
  const agentId = typeof a.agentId === "string" ? a.agentId : null;

  const byName = new Map<string, SkillPayload>();
  const budget = { bytes: 2 };
  for (const root of resolveSkillRoots(agentId, cwd)) scanSkillRoot(root, byName, budget);

  // Stable lower-case sort so the picker doesn't shuffle between calls.
  return Array.from(byName.values()).sort((x, y) =>
    x.name.toLowerCase().localeCompare(y.name.toLowerCase()),
  );
};
