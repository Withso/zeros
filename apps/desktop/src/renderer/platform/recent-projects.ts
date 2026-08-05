// ──────────────────────────────────────────────────────────
// Recent projects list
// ──────────────────────────────────────────────────────────
//
// Stored in apps/desktop/src/renderer/platform/settings.ts (localStorage under "zeros-recent-
// projects-v1"). The "Workspace Manager" dropdown in Repository panel reads
// this list; every time the user opens a folder, we upsert + bump
// `lastOpened` so the list stays most-recent-first.
//
// Entries are bounded to RECENT_LIMIT so the list never grows
// unboundedly if the user bounces between folders all day.
// ──────────────────────────────────────────────────────────

import { getSetting, setSetting } from "./settings";

export type RecentProject = {
  path: string;
  name: string;
  lastOpened: number;
};

const KEY = "recent-projects-v1";
const RECENT_LIMIT = 12;

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

export function rememberProject(path: string): RecentProject {
  const list = getSetting<RecentProject[]>(KEY, []);
  const entry: RecentProject = {
    path,
    name: basename(path) || path,
    lastOpened: Date.now(),
  };
  const deduped = list.filter((p) => p.path !== path);
  const next = [entry, ...deduped].slice(0, RECENT_LIMIT);
  setSetting(KEY, next);
  return entry;
}
