
export { selectRepositorySetup, quoteSetupArgument } from "./repository-setup";
export type { RepositorySetupSelection } from "./repository-setup";

export const RUN_ACTION_PLATFORMS = ["mac", "linux", "win"] as const;
export type RunActionPlatform = (typeof RUN_ACTION_PLATFORMS)[number];

/** Keep the migrated action ID fixed so existing unsuffixed run terminals reattach. */
export const LEGACY_RUN_ACTION_ID = "run";

export interface RunAction {
  /** Stable ID used in persisted run terminal identity. */
  id: string;
  name: string;
  command: string;
  /** Lucide icon name (curated registry; unknown names fall back to play). */
  icon?: string;
  /** OSes this action shows on. Absent/empty = all. */
  platforms?: RunActionPlatform[];
  /** true → one-shot verdict (finished/failed by exit code); false →
   *  long-lived (dev server: running/stopped only). Absent = heuristic. */
  oneShot?: boolean;
  runOnCreate?: boolean;
  /** The header action and shortcut use the normalized default. */
  isDefault?: boolean;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function optionalBool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

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

/** An explicit run_actions array, even when empty, suppresses the legacy scripts.run fallback. */
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
  const flagged = actions.findIndex((a) => a.isDefault === true);
  const defaultIndex = flagged >= 0 ? flagged : 0;
  return actions.map((a, i) =>
    i === defaultIndex ? { ...a, isDefault: true } : { ...a, isDefault: false },
  );
}

/** Preserve the pty-run- prefix, folder hash and unsuffixed legacy ID so devices reattach to existing persisted terminals. */
export function runSessionId(
  folder: string,
  actionId: string = LEGACY_RUN_ACTION_ID,
): string {
  let h = 5381;
  for (let i = 0; i < folder.length; i++)
    h = ((h << 5) + h + folder.charCodeAt(i)) | 0;
  const base = `pty-run-${(h >>> 0).toString(36)}`;
  if (actionId === LEGACY_RUN_ACTION_ID) return base;
  // Arbitrary TOML IDs must remain valid as persisted session ID suffixes.
  return `${base}-${actionId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

export function isRunSessionId(id: string): boolean {
  return id.startsWith("pty-run-");
}

/** Check long-lived markers first so watch mode wins over test. */
const LONG_LIVED_RE = /\b(dev|serve|server|start|watch|storybook|preview|tail)\b/i;
const ONE_SHOT_RE = /\b(test|build|lint|typecheck|tsc|check|format|fmt|compile|ci)\b/i;

/** Unknown commands default to long-lived to avoid showing a stopped server as failed. */
export function isOneShotCommand(command: string): boolean {
  if (LONG_LIVED_RE.test(command)) return false;
  return ONE_SHOT_RE.test(command);
}

export function runActionOneShot(action: RunAction): boolean {
  return action.oneShot ?? isOneShotCommand(action.command);
}

/** Unknown platforms disable filtering rather than hiding actions. */
export function normalizeRunPlatform(raw: string): RunActionPlatform | null {
  const v = raw.toLowerCase();
  if (v.includes("darwin") || v.includes("mac")) return "mac";
  if (v.includes("win")) return "win";
  if (v.includes("linux")) return "linux";
  return null;
}

export function filterRunActionsForPlatform(
  actions: RunAction[],
  platform: RunActionPlatform | null,
): RunAction[] {
  if (!platform) return actions;
  const eligible = actions.filter(
    (a) => !a.platforms || a.platforms.length === 0 || a.platforms.includes(platform),
  );
  // A hidden default must be replaced for the header action.
  if (eligible.length > 0 && !eligible.some((a) => a.isDefault)) {
    return eligible.map((a, i) => (i === 0 ? { ...a, isDefault: true } : a));
  }
  return eligible;
}
