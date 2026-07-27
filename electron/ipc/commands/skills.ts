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
function resolveSkillRoots(agentId: string | null, cwd: string | null): string[] {
  const home = os.homedir();
  const roots: string[] = [];
  switch (agentId) {
    case "claude":
      if (cwd) roots.push(path.join(cwd, ".claude", "skills"));
      roots.push(path.join(home, ".claude", "skills"));
      break;
    case "codex": {
      const codexHome = process.env.CODEX_HOME?.trim() || path.join(home, ".codex");
      if (cwd) roots.push(path.join(cwd, ".codex", "skills"));
      roots.push(path.join(codexHome, "skills"));
      break;
    }
    case "cursor":
      if (cwd) roots.push(path.join(cwd, ".cursor", "skills"));
      roots.push(path.join(home, ".cursor", "skills"));
      break;
    default:
      // Unknown/no agent → the home Claude library is the most complete default.
      roots.push(path.join(home, ".claude", "skills"));
      break;
  }
  // Project-level `<cwd>/skills` (the original convention) for every agent.
  if (cwd) roots.push(path.join(cwd, "skills"));
  return roots;
}

/** Scan ONE skill root into `byName`. Accepts both the `<name>/SKILL.md`
 *  subdirectory convention (Claude/Codex/Cursor) and a flat `<name>.md` file.
 *  Earlier roots win — a name already present is left untouched (workspace
 *  overrides user-home). Missing/unreadable dirs are skipped. */
function scanSkillRoot(dir: string, byName: Map<string, SkillPayload>): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // dir absent / unreadable → no skills from here
  }
  for (const entry of entries) {
    let file: string | null = null;
    let id = "";
    if (entry.isDirectory()) {
      const candidate = path.join(dir, entry.name, "SKILL.md");
      if (fs.existsSync(candidate)) {
        file = candidate;
        id = entry.name;
      }
    } else if (entry.isFile() && path.extname(entry.name) === ".md") {
      file = path.join(dir, entry.name);
      id = path.basename(entry.name, ".md");
    }
    if (!file) continue;

    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    const { fm, body } = splitFrontmatter(raw);
    const name = fm.get("name") || id;
    if (byName.has(name)) continue; // earlier (workspace) root wins
    byName.set(name, {
      id,
      name,
      description: fm.get("description") ?? "",
      icon: fm.get("icon") ?? "Sparkles",
      body,
      path: file,
    });
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
  for (const root of resolveSkillRoots(agentId, cwd)) scanSkillRoot(root, byName);

  // Stable lower-case sort so the picker doesn't shuffle between calls.
  return Array.from(byName.values()).sort((x, y) =>
    x.name.toLowerCase().localeCompare(y.name.toLowerCase()),
  );
};
