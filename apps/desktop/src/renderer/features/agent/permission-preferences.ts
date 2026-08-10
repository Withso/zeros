// Durable permission-mode memory, scoped by agent family.
//
// Permission modes are agent settings, not model settings: switching between
// two Codex models should not reset Approve for me, while switching to Claude
// must restore Claude's own last choice. Store the exact native id because the
// coarse ChatPermissionMode posture is lossy (Claude `accept-edits` and `auto`
// both map to `auto`). The localStorage copy is the synchronous new-chat cache;
// new-chat-defaults.ts mirrors the same bounded records into settings.toml.

import { getSetting, setSetting } from "../../platform/settings";
import type { ChatPermissionMode } from "../../state/store";
import {
  agentFamily,
  nativeModeIdForPosture,
  permissionForAgentMode,
  permissionMenuItems,
} from "./model-catalog";

export const PERMISSION_PREFERENCES_KEY = "permission-preferences-by-agent";
export const MAX_PERMISSION_PREFERENCES = 32;

export interface PersistedPermissionPreference {
  /** Canonical family when known; otherwise the normalized extension id. */
  agent: string;
  /** Exact native adapter mode id (for example `auto-edit` or `accept-edits`). */
  mode: string;
}

export interface PermissionConfiguration {
  modeId: string | null;
  permissionMode: ChatPermissionMode;
}

function preferenceOwner(agentId: string | null | undefined): string {
  const family = agentFamily(agentId ?? null);
  if (family) return family;
  return typeof agentId === "string" ? agentId.trim().toLowerCase() : "";
}

function sanitizeRecord(value: unknown): PersistedPermissionPreference | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.agent !== "string" || !raw.agent.trim()) return null;
  if (typeof raw.mode !== "string" || !raw.mode.trim()) return null;
  const agent = preferenceOwner(raw.agent);
  return agent ? { agent, mode: raw.mode.trim() } : null;
}

/** Last duplicate wins, then only the most-recent bounded tail survives. */
function sanitizeRecords(value: unknown): PersistedPermissionPreference[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const reversed: PersistedPermissionPreference[] = [];
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const record = sanitizeRecord(value[index]);
    if (!record || seen.has(record.agent)) continue;
    seen.add(record.agent);
    reversed.push(record);
    if (reversed.length >= MAX_PERMISSION_PREFERENCES) break;
  }
  return reversed.reverse();
}

function readRecords(): PersistedPermissionPreference[] {
  return sanitizeRecords(getSetting<unknown>(PERMISSION_PREFERENCES_KEY, []));
}

function writeRecords(records: PersistedPermissionPreference[]): void {
  setSetting(PERMISSION_PREFERENCES_KEY, sanitizeRecords(records));
}

export function hasPermissionPreferenceStorage(): boolean {
  return getSetting<unknown>(PERMISSION_PREFERENCES_KEY, null) !== null;
}

export function getPermissionPreference(
  agentId: string | null | undefined,
): string | null {
  const owner = preferenceOwner(agentId);
  if (!owner) return null;
  return readRecords().find((record) => record.agent === owner)?.mode ?? null;
}

/** Resolve memory against the family's current vocabulary. Unknown extension
 * agents retain their opaque exact id; known families reject a retired or
 * corrupt id and safely return to their product Auto default. */
export function resolvePermissionConfiguration(
  agentId: string | null | undefined,
): PermissionConfiguration {
  const saved = getPermissionPreference(agentId);
  const available = permissionMenuItems(agentId ?? null, null);
  const validSaved =
    saved &&
    (available.length === 0 || available.some((item) => item.modeId === saved))
      ? saved
      : null;
  const modeId =
    validSaved ?? nativeModeIdForPosture(agentId ?? null, "auto") ?? null;
  return {
    modeId,
    permissionMode: modeId
      ? permissionForAgentMode(modeId, agentId ?? null)
      : "auto",
  };
}

/** Merge one user's choice and move it to the MRU end of the bounded store. */
export function setPermissionPreference(
  agentId: string | null | undefined,
  modeId: string | null | undefined,
): void {
  const agent = preferenceOwner(agentId);
  const mode = typeof modeId === "string" ? modeId.trim() : "";
  if (!agent || !mode) return;
  const records = readRecords();
  writeRecords([
    ...records.filter((record) => record.agent !== agent),
    { agent, mode },
  ]);
}

/** Settings hydration boundary: invalid rows are dropped independently. */
export function replacePermissionPreferences(value: unknown): void {
  writeRecords(sanitizeRecords(value));
}

export function serializePermissionPreferences(): PersistedPermissionPreference[] {
  return readRecords();
}
