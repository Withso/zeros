// ──────────────────────────────────────────────────────────
// Run actions — the shared `[scripts.run_actions]` model
// ──────────────────────────────────────────────────────────
//
// One repo may declare MULTIPLE named run actions (dev server, tests,
// storybook…), each with an icon, a platform filter, and a one-shot flag:
//
//   [[scripts.run_actions]]
//   id = "dev"
//   name = "Dev"
//   command = "pnpm dev"
//   icon = "play"
//   default = true
//
// This module is the single parser/normalizer BOTH sides run: the engine
// (resolving what to spawn — apps/desktop/src/engine/settings/repo-scripts.ts) and the
// renderer (deciding which Run sub-tabs / menu items to render —
// apps/desktop/src/renderer/shell/terminal/use-run-control.ts). Pure TS, no runtime deps, so it can
// live on either side of the bridge.
//
// Legacy migration is READ-TIME: a repo with only the old single `scripts.run`
// string resolves to one default action with the fixed id "run" — nothing is
// rewritten on disk, and that id maps back to the legacy per-folder session id
// so existing persisted run terminals keep matching (see runSessionId).
// ──────────────────────────────────────────────────────────

export const RUN_ACTION_PLATFORMS = ["mac", "linux", "win"] as const;
export type RunActionPlatform = (typeof RUN_ACTION_PLATFORMS)[number];

/** The id the legacy single `scripts.run` string migrates to. Fixed so the
 *  migrated action's session id stays the legacy `pty-run-<hash>` (no suffix)
 *  and a pre-migration run terminal reattaches seamlessly. */
export const LEGACY_RUN_ACTION_ID = "run";

export interface RunAction {
  /** Stable id — React key + session-id suffix + status key. */
  id: string;
  /** Tab / menu / button label, e.g. "Dev". */
  name: string;
  /** Shell command, e.g. "pnpm dev". */
  command: string;
  /** Lucide icon name (curated registry; unknown names fall back to play). */
  icon?: string;
  /** OSes this action shows on. Absent/empty = all. */
  platforms?: RunActionPlatform[];
  /** true → one-shot verdict (finished/failed by exit code); false →
   *  long-lived (dev server: running/stopped only). Absent = heuristic. */
  oneShot?: boolean;
  /** Start automatically when a workspace is created. */
  runOnCreate?: boolean;
  /** The header split-button face + primary (⌘R) shortcut. Exactly one action
   *  is default after normalization. */
  isDefault?: boolean;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function optionalBool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

/** Normalize one raw `[[scripts.run_actions]]` table (snake_case TOML keys).
 *  Null for an entry missing any required field — the caller skips it. */
function parseOne(raw: unknown): RunAction | null {
  if (!isPlainObject(raw)) return null;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const command = typeof raw.command === "string" ? raw.command.trim() : "";
  if (!id || !name || !command) return null;
  const icon = typeof raw.icon === "string" && raw.icon.trim() ? raw.icon.trim() : undefined;
  const platforms = Array.isArray(raw.platforms)
    ? (raw.platforms.filter((p) =>
        (RUN_ACTION_PLATFORMS as readonly string[]).includes(p as string),
      ) as RunActionPlatform[])
    : undefined;
  return {
    id,
    name,
    command,
    ...(icon ? { icon } : {}),
    ...(platforms && platforms.length > 0 ? { platforms } : {}),
    ...(optionalBool(raw.one_shot) !== undefined ? { oneShot: raw.one_shot as boolean } : {}),
    ...(optionalBool(raw.run_on_create) !== undefined
      ? { runOnCreate: raw.run_on_create as boolean }
      : {}),
    ...(optionalBool(raw.default) !== undefined ? { isDefault: raw.default as boolean } : {}),
  };
}

/** Parse the resolved `scripts` table into a normalized action list:
 *   • invalid entries are skipped (never the whole list),
 *   • duplicate ids keep the FIRST occurrence,
 *   • exactly one default (the first flagged one, else the first action),
 *   • with run_actions ABSENT entirely, a legacy `scripts.run` string becomes
 *     one default action (id "run") — the read-time migration. An EXPLICIT
 *     empty array means "none configured": the Run-actions editor writes []
 *     when the user deletes every action, and the legacy string must not
 *     resurrect one (the "removed the script but Rerun still shows" bug). */
export function parseRunActions(scripts: unknown): RunAction[] {
  if (!isPlainObject(scripts)) return [];
  const seen = new Set<string>();
  const actions: RunAction[] = [];
  const hasExplicitList = Array.isArray(scripts.run_actions);
  if (hasExplicitList) {
    for (const raw of scripts.run_actions as unknown[]) {
      const action = parseOne(raw);
      if (!action || seen.has(action.id)) continue;
      seen.add(action.id);
      actions.push(action);
    }
  }
  if (actions.length === 0 && !hasExplicitList) {
    const legacy = typeof scripts.run === "string" ? scripts.run.trim() : "";
    if (legacy) {
      actions.push({
        id: LEGACY_RUN_ACTION_ID,
        name: "Run",
        command: legacy,
        icon: "play",
        isDefault: true,
      });
    }
  }
  // Exactly one default: the first flagged, else the first action.
  const flagged = actions.findIndex((a) => a.isDefault === true);
  const defaultIndex = flagged >= 0 ? flagged : 0;
  return actions.map((a, i) =>
    i === defaultIndex ? { ...a, isDefault: true } : { ...a, isDefault: false },
  );
}

/** Stable, id-shaped PTY session id for one (folder, action) run terminal.
 *  Deterministic, so a repeat Run reattaches to the live process instead of
 *  spawning a duplicate, and the engine + every device land on the SAME id.
 *  The `pty-run-` prefix is the canonical "this is a run terminal" marker
 *  (persisted, reload-stable). The legacy migrated action (id "run") maps to
 *  the UNSUFFIXED legacy id so pre-migration run terminals keep matching.
 *  (The djb2 hash is verbatim from the renderer's original runSessionId —
 *  it MUST stay identical for the same reason.) */
export function runSessionId(
  folder: string,
  actionId: string = LEGACY_RUN_ACTION_ID,
): string {
  let h = 5381;
  for (let i = 0; i < folder.length; i++)
    h = ((h << 5) + h + folder.charCodeAt(i)) | 0;
  const base = `pty-run-${(h >>> 0).toString(36)}`;
  if (actionId === LEGACY_RUN_ACTION_ID) return base;
  // Session ids travel through bridge messages + persistence — keep the
  // suffix id-shaped whatever the TOML id contains.
  return `${base}-${actionId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

/** True for any per-action run terminal (prefix-based, reload-stable). */
export function isRunSessionId(id: string): boolean {
  return id.startsWith("pty-run-");
}

/** Long-lived (server-ish) command markers — checked FIRST so "vitest --watch"
 *  reads long-lived even though it also matches "test". */
const LONG_LIVED_RE = /\b(dev|serve|server|start|watch|storybook|preview|tail)\b/i;
/** One-shot (verdict-ish) command markers. */
const ONE_SHOT_RE = /\b(test|build|lint|typecheck|tsc|check|format|fmt|compile|ci)\b/i;

/** Heuristic one-shot detection for actions without an explicit flag. Unknown
 *  commands default to LONG-LIVED: a neutral "stopped" for a finished test is
 *  a milder error than a red "failed" for a Ctrl-C'd server. */
export function isOneShotCommand(command: string): boolean {
  if (LONG_LIVED_RE.test(command)) return false;
  return ONE_SHOT_RE.test(command);
}

/** An action's effective one-shot mode (explicit flag, else the heuristic). */
export function runActionOneShot(action: RunAction): boolean {
  return action.oneShot ?? isOneShotCommand(action.command);
}

/** Map a Node `process.platform` / browser UA hint onto the settings platform
 *  vocabulary. Unknown → null (no filtering — better to show than to hide). */
export function normalizeRunPlatform(raw: string): RunActionPlatform | null {
  const v = raw.toLowerCase();
  if (v.includes("darwin") || v.includes("mac")) return "mac";
  if (v.includes("win")) return "win";
  if (v.includes("linux")) return "linux";
  return null;
}

/** Actions eligible on `platform` (null = no filtering). An action with no
 *  `platforms` list runs everywhere. */
export function filterRunActionsForPlatform(
  actions: RunAction[],
  platform: RunActionPlatform | null,
): RunAction[] {
  if (!platform) return actions;
  const eligible = actions.filter(
    (a) => !a.platforms || a.platforms.length === 0 || a.platforms.includes(platform),
  );
  // Platform filtering can drop the default — re-normalize so the header
  // split-button face always has one.
  if (eligible.length > 0 && !eligible.some((a) => a.isDefault)) {
    return eligible.map((a, i) => (i === 0 ? { ...a, isDefault: true } : a));
  }
  return eligible;
}
