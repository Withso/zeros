// ──────────────────────────────────────────────────────────
// Slash command + subagent discovery — shared, file-based
// ──────────────────────────────────────────────────────────
//
// Most agents ship a "drop a markdown file in <dir> and the agent
// treats it as a custom command or a subagent" convention. Most of
// them use file-based stores that go undiscovered by our composer
// until we scan the directories ourselves.
//
// This module owns:
//   - scanCommandDir(root) — read ~/.claude/commands/*.md style dirs
//     into AvailableCommand[] (name + description from frontmatter).
//   - resolveCommandRoots(agentId, cwd) — return the per-agent dir
//     hierarchy (user-home + workspace) to scan, in precedence order
//     (workspace overrides user).
//
// File format (cross-agent, deliberately Claude-compatible):
//   ---
//   name: my-command           # optional, falls back to basename
//   description: do something  # optional
//   input: { hint: "args" }    # optional
//   ---
//   <free-form system-prompt / instructions>
//
// We tolerate missing/malformed frontmatter (treat the file as having
// no front-matter; name = basename, description = first non-empty body
// line). Anything inside the body is ignored — agents own that.
//
// Note: this module does NOT invoke any agent. Discovery is read-only
// filesystem inspection. The composer surfaces these via the existing
// SlashCommandPicker (slash-command-picker.tsx) by emitting the
// canonical `available_commands_update` notification from the adapter.
//
// ──────────────────────────────────────────────────────────

import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { AvailableCommand } from "@zeros/protocol/agent-events";

/** Per-agent root resolution. Returns the dirs to scan in precedence
 *  order — workspace overrides user. Missing dirs are NOT created.  */
export function resolveCommandRoots(args: {
  agentId: string;
  cwd: string;
}): string[] {
  const home = os.homedir();
  switch (args.agentId) {
    case "claude":
      return [
        path.join(args.cwd, ".claude", "commands"),
        path.join(home, ".claude", "commands"),
      ];
    case "cursor":
      return [
        path.join(args.cwd, ".cursor", "commands"),
        path.join(home, ".cursor", "commands"),
      ];
    case "codex": {
      // Codex custom prompts live in $CODEX_HOME/prompts (default
      // ~/.codex/prompts) and surface as slash commands. No documented
      // workspace-level dir, but we scan `.codex/prompts` too for parity
      // (harmless when absent — readDirSafe returns []).
      const codexHome =
        process.env.CODEX_HOME?.trim() || path.join(home, ".codex");
      return [
        path.join(args.cwd, ".codex", "prompts"),
        path.join(codexHome, "prompts"),
      ];
    }
    default:
      return [];
  }
}

/** Scan a single directory of .md files into AvailableCommand[]. Returns
 *  empty array on missing/unreadable dir (not an error). */
export async function scanCommandDir(dir: string): Promise<AvailableCommand[]> {
  const files = await readDirSafe(dir);
  const out: AvailableCommand[] = [];
  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    const full = path.join(dir, file);
    const meta = await readFrontmatter(full);
    const name = meta.frontmatter.name ?? file.slice(0, -3);
    const description = meta.frontmatter.description ?? meta.firstLine ?? "";
    const input = meta.frontmatter.input as { hint?: unknown } | undefined;
    const inputHint =
      input && typeof input.hint === "string" ? input.hint : undefined;
    const cmd: AvailableCommand = {
      name: String(name),
      description: String(description),
      // File-based discovery only finds USER-AUTHORED custom commands (the
      // `.claude/commands`, `~/.codex/prompts`, … convention) — never skills,
      // which each agent reports through its own channel. So these are always
      // commands.
      kind: "command",
    };
    if (inputHint) cmd.input = { hint: inputHint };
    out.push(cmd);
  }
  return out;
}

/** Discover all commands for an agent across its dir hierarchy.
 *  Workspace dir entries override user-home entries on `name` clash. */
export async function discoverCommands(args: {
  agentId: string;
  cwd: string;
}): Promise<AvailableCommand[]> {
  const roots = resolveCommandRoots(args);
  const byName = new Map<string, AvailableCommand>();
  // Reverse-iterate so workspace (first root) wins over user-home.
  for (let i = roots.length - 1; i >= 0; i--) {
    const list = await scanCommandDir(roots[i]);
    for (const cmd of list) byName.set(cmd.name, cmd);
  }
  return Array.from(byName.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

// ── internals ─────────────────────────────────────────────

async function readDirSafe(dir: string): Promise<string[]> {
  try {
    return await fsp.readdir(dir);
  } catch {
    return [];
  }
}

interface ParsedMeta {
  frontmatter: Record<string, unknown>;
  firstLine: string | null;
}

/** Lightweight YAML frontmatter reader. Only handles flat key:value
 *  pairs plus the one nested `input: { hint: "..." }` shape we care
 *  about. Tools field is recognised as inline-array `[a, b, c]` or
 *  YAML-list block (`- a\n- b`). Anything more complex is ignored;
 *  callers tolerate undefined keys. */
async function readFrontmatter(filePath: string): Promise<ParsedMeta> {
  let raw: string;
  try {
    raw = await fsp.readFile(filePath, "utf-8");
  } catch {
    return { frontmatter: {}, firstLine: null };
  }
  const out: Record<string, unknown> = {};
  let body = raw;
  if (raw.startsWith("---\n")) {
    const end = raw.indexOf("\n---\n", 4);
    if (end > 0) {
      const yaml = raw.slice(4, end);
      body = raw.slice(end + 5);
      parseFlatYaml(yaml, out);
    }
  }
  const firstBodyLine =
    body
      .split("\n")
      .map((s) => s.trim())
      .find((l) => l.length > 0) ?? null;
  return { frontmatter: out, firstLine: firstBodyLine };
}

function parseFlatYaml(yaml: string, out: Record<string, unknown>): void {
  const lines = yaml.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!m) {
      i++;
      continue;
    }
    const key = m[1];
    let value: unknown = m[2].trim();
    // Strip surrounding quotes if present.
    if (
      typeof value === "string" &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    // Inline-array `[a, b, c]`.
    if (
      typeof value === "string" &&
      value.startsWith("[") &&
      value.endsWith("]")
    ) {
      value = value
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    }
    // Nested input: hint (one specific case we need).
    if (key === "input" && (value === "" || value === undefined)) {
      const sub = lines[i + 1];
      if (sub && /^\s{2,}hint:\s*/.test(sub)) {
        const hintMatch = /^\s+hint:\s*(.*)$/.exec(sub);
        if (hintMatch) {
          let hint = hintMatch[1].trim();
          if (
            (hint.startsWith('"') && hint.endsWith('"')) ||
            (hint.startsWith("'") && hint.endsWith("'"))
          ) {
            hint = hint.slice(1, -1);
          }
          out.input = { hint };
          i += 2;
          continue;
        }
      }
    }
    // YAML-list block:  tools:\n  - Read\n  - Edit
    if (
      key === "tools" &&
      (value === "" || value === undefined) &&
      i + 1 < lines.length &&
      /^\s+-\s+/.test(lines[i + 1])
    ) {
      const items: string[] = [];
      let j = i + 1;
      while (j < lines.length && /^\s+-\s+/.test(lines[j])) {
        const lm = /^\s+-\s+(.*)$/.exec(lines[j]);
        if (lm) {
          let v = lm[1].trim();
          if (
            (v.startsWith('"') && v.endsWith('"')) ||
            (v.startsWith("'") && v.endsWith("'"))
          ) {
            v = v.slice(1, -1);
          }
          items.push(v);
        }
        j++;
      }
      out.tools = items;
      i = j;
      continue;
    }
    out[key] = value;
    i++;
  }
}
