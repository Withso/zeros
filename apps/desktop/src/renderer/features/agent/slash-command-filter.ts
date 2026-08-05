// ──────────────────────────────────────────────────────────
// Slash-command ranked filter (non-component helpers)
// ──────────────────────────────────────────────────────────
//
// Lives OUTSIDE slash-command-picker.tsx on purpose: exporting a plain
// function from a component module breaks Vite React Fast Refresh
// ("consistent-components-exports"), which forced a full page reload —
// visibly killing the open picker — on every edit of the picker file.
// ──────────────────────────────────────────────────────────

import type { AvailableCommand } from "../../platform/bridge/agent-events";

/** Case-insensitive contains, ranked by match position so
 *  shorter-prefix matches float to the top. The default limit is generous
 *  (the menu is scrollable) so typing `/` lists the agent's whole
 *  catalogue rather than an arbitrary first slice. */
export function filterSlashCommands(
  commands: AvailableCommand[],
  query: string,
  limit = 50,
): AvailableCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands.slice(0, limit);
  const scored: Array<{ cmd: AvailableCommand; score: number }> = [];
  for (const cmd of commands) {
    const idx = cmd.name.toLowerCase().indexOf(q);
    if (idx < 0) continue;
    scored.push({ cmd, score: idx });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, limit).map((s) => s.cmd);
}
