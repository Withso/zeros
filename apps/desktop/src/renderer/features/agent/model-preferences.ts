// Per-model composer configuration memory.
//
// Effort and Fast belong to an exact (agent family, model id) pair. They must
// never be carried from the model that happened to be active previously: Sol
// at Max/Fast and Terra at Medium/non-Fast are two independent durable choices.
// The localStorage copy is the synchronous spawn cache; new-chat-defaults.ts
// mirrors the same bounded records into the user settings.toml file.

import { useEffect, useState } from "react";

import type { InitializeResponse } from "../../platform/bridge/agent-events";
import { getSetting, setSetting } from "../../platform/settings";
import type { ChatEffort } from "../../state/store";
import {
  agentFamily,
  agentSupportsFast,
  defaultEffortForLevels,
  effortLevelsFor,
  modelsForAgent,
} from "./model-catalog";
import { effectiveFavoriteModel } from "./model-favorites";

/** Re-exported from model-catalog, which owns it so the label/env clamp
 * (`effectiveEffort`) and this remembered-value default can never diverge. */
export { defaultEffortForLevels };

export const MODEL_PREFERENCES_KEY = "model-preferences-by-model";
export const MAX_MODEL_PREFERENCES = 128;

export interface ModelConfiguration {
  effort: ChatEffort;
  fast: boolean;
}

export interface PersistedModelPreference {
  /** Canonical family when known; otherwise the normalized agent id. */
  agent: string;
  /** Exact provider wire id. Model aliases and context suffixes stay distinct. */
  model: string;
  effort?: ChatEffort;
  fast?: boolean;
}

const VALID_EFFORTS = new Set<ChatEffort>([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultracode",
]);
function preferenceOwner(agentId: string | null | undefined): string {
  const family = agentFamily(agentId ?? null);
  if (family) return family;
  return typeof agentId === "string" ? agentId.trim().toLowerCase() : "";
}

function concreteModel(
  agentId: string | null | undefined,
  model: string | null | undefined,
  initialize: InitializeResponse | null = null,
): string {
  if (typeof model === "string" && model.trim()) return model.trim();
  return (
    effectiveFavoriteModel(agentId) ??
    modelsForAgent(agentId ?? null, initialize)[0]?.value ??
    ""
  );
}

function sanitizeRecord(value: unknown): PersistedModelPreference | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.agent !== "string" || !raw.agent.trim()) return null;
  if (typeof raw.model !== "string" || !raw.model.trim()) return null;
  const record: PersistedModelPreference = {
    agent: preferenceOwner(raw.agent),
    model: raw.model.trim(),
  };
  if (
    typeof raw.effort === "string" &&
    VALID_EFFORTS.has(raw.effort as ChatEffort)
  ) {
    record.effort = raw.effort as ChatEffort;
  }
  if (typeof raw.fast === "boolean") record.fast = raw.fast;
  if (
    !record.agent ||
    (record.effort === undefined && record.fast === undefined)
  ) {
    return null;
  }
  return record;
}

/** Last duplicate wins, then the most-recent bounded tail survives. */
function sanitizeRecords(value: unknown): PersistedModelPreference[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const reversed: PersistedModelPreference[] = [];
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const record = sanitizeRecord(value[index]);
    if (!record) continue;
    const key = `${record.agent}\u0000${record.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    reversed.push(record);
    if (reversed.length >= MAX_MODEL_PREFERENCES) break;
  }
  return reversed.reverse();
}

function readRecords(): PersistedModelPreference[] {
  return sanitizeRecords(getSetting<unknown>(MODEL_PREFERENCES_KEY, []));
}

function writeRecords(records: PersistedModelPreference[]): void {
  setSetting(MODEL_PREFERENCES_KEY, sanitizeRecords(records));
  notify();
}

export function hasModelPreferenceStorage(): boolean {
  return getSetting<unknown>(MODEL_PREFERENCES_KEY, null) !== null;
}

/** Raw remembered values. Capability validation happens at resolution time so
 * a temporarily unavailable live capability snapshot never destroys a choice. */
export function getModelPreference(
  agentId: string | null | undefined,
  model: string | null | undefined,
  initialize: InitializeResponse | null = null,
): Pick<PersistedModelPreference, "effort" | "fast"> | null {
  const agent = preferenceOwner(agentId);
  const exactModel = concreteModel(agentId, model, initialize);
  if (!agent || !exactModel) return null;
  const hit = readRecords().find(
    (record) => record.agent === agent && record.model === exactModel,
  );
  if (!hit) return null;
  const result: Pick<PersistedModelPreference, "effort" | "fast"> = {};
  if (hit.effort) result.effort = hit.effort;
  if (typeof hit.fast === "boolean") result.fast = hit.fast;
  return result;
}

/** Resolve a safe configuration from memory and current model capabilities. */
export function resolveModelConfiguration(
  agentId: string | null | undefined,
  model: string | null | undefined,
  initialize: InitializeResponse | null = null,
): ModelConfiguration {
  const exactModel = concreteModel(agentId, model, initialize);
  const levels = effortLevelsFor(
    agentId ?? null,
    exactModel || null,
    initialize,
  );
  const saved = getModelPreference(agentId, exactModel, initialize);
  const effort =
    saved?.effort && levels.includes(saved.effort)
      ? saved.effort
      : defaultEffortForLevels(levels);
  const fast =
    saved?.fast === true &&
    agentSupportsFast(agentId ?? null, exactModel || null, initialize);
  return { effort, fast };
}

/** Merge one user's choice and move it to the MRU end of the bounded store. */
export function setModelPreference(
  agentId: string | null | undefined,
  model: string | null | undefined,
  next: Partial<ModelConfiguration>,
  initialize: InitializeResponse | null = null,
): void {
  const agent = preferenceOwner(agentId);
  const exactModel = concreteModel(agentId, model, initialize);
  if (!agent || !exactModel) return;

  const records = readRecords();
  const existing = records.find(
    (record) => record.agent === agent && record.model === exactModel,
  );
  const merged: PersistedModelPreference = {
    agent,
    model: exactModel,
    ...(existing?.effort ? { effort: existing.effort } : {}),
    ...(typeof existing?.fast === "boolean" ? { fast: existing.fast } : {}),
  };
  if (next.effort && VALID_EFFORTS.has(next.effort))
    merged.effort = next.effort;
  if (typeof next.fast === "boolean") merged.fast = next.fast;

  writeRecords([
    ...records.filter(
      (record) => record.agent !== agent || record.model !== exactModel,
    ),
    merged,
  ]);
}

/** Settings hydration boundary: invalid rows are dropped independently. */
export function replaceModelPreferences(value: unknown): void {
  writeRecords(sanitizeRecords(value));
}

export function serializeModelPreferences(): PersistedModelPreference[] {
  return readRecords();
}

type Listener = () => void;
const listeners = new Set<Listener>();

function notify(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // A stale surface must not stop the remaining model menus from syncing.
    }
  }
}

/** Re-render surfaces that display several models without calling hooks in a loop. */
export function useModelPreferencesVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const sync = () => setVersion((current) => current + 1);
    listeners.add(sync);
    return () => {
      listeners.delete(sync);
    };
  }, []);
  return version;
}
