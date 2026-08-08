// The one global default model (rendered as the single filled star).
//
// Older builds stored one favorite per provider family plus a separate default
// agent. That allowed three stars and let the two identities drift. The new
// record publishes agent + model atomically. The legacy keys remain migration
// inputs and are dual-written with only this one selection for downgrade safety.
//
// This module owns the WRITE side and the pub/sub bus. The READ side
// (getFavoriteSelection / getFavoriteModel / effectiveFavoriteModel) lives in
// model-catalog.ts and is re-exported below, because model-catalog has to
// resolve a null ChatThread.model through the exact same chain — see the
// "one global default-model selection (READ side)" block there.

import { useEffect, useState } from "react";

import { setSetting } from "../../platform/settings";
import {
  agentFamily,
  DEFAULT_MODEL_SELECTION_KEY,
  LEGACY_DEFAULT_AGENT_KEY,
  LEGACY_FAVORITE_MODELS_KEY,
  legacyFavoriteSelection,
  type FavoriteModelSelection,
} from "./model-catalog";

export {
  effectiveFavoriteModel,
  getFavoriteModel,
  getFavoriteSelection,
  type FavoriteModelSelection,
} from "./model-catalog";

/** Set the single global favorite. Selecting another family atomically moves
 * both the star and the new-chat agent. `null` keeps the agent but returns its
 * model to the catalog fallback. */
export function setFavoriteModel(
  agentId: string | null | undefined,
  modelValue: string | null,
): void {
  const family = agentFamily(agentId ?? null);
  if (!family) return;
  const selection: FavoriteModelSelection = {
    agentId: family,
    model:
      typeof modelValue === "string" && modelValue.trim().length > 0
        ? modelValue.trim()
        : null,
  };
  setSetting(DEFAULT_MODEL_SELECTION_KEY, selection);

  // Explicit compatibility migration: old builds still see one coherent
  // default instead of the pre-migration multi-family map.
  setSetting(LEGACY_DEFAULT_AGENT_KEY, family);
  setSetting(
    LEGACY_FAVORITE_MODELS_KEY,
    selection.model ? { [family]: selection.model } : {},
  );
  notify();
}

/** Move a pre-redesign `default-agent-id` + `favorite-models-by-family` pair
 * into the one atomic record. Idempotent, cheap, and safe to call from a boot
 * effect: resolution already answers correctly from the legacy keys, so this
 * only normalizes storage.
 *
 * It lives here — a write path called once at boot — rather than inside
 * `getFavoriteSelection`, because that read runs during render on every model
 * surface, and a render-phase storage write is a side effect React is entitled
 * to double-invoke or discard. Returns whether anything moved. */
export function migrateDefaultModelSelection(): boolean {
  const legacy = legacyFavoriteSelection();
  if (!legacy) return false;
  setSetting(DEFAULT_MODEL_SELECTION_KEY, legacy);
  notify();
  return true;
}

export function clearFavoriteSelection(): void {
  setSetting(DEFAULT_MODEL_SELECTION_KEY, null);
  setSetting(LEGACY_DEFAULT_AGENT_KEY, null);
  setSetting(LEGACY_FAVORITE_MODELS_KEY, {});
  notify();
}

type Listener = () => void;
const listeners = new Set<Listener>();

function notify(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // Keep the remaining mounted menus/settings surfaces synchronized.
    }
  }
}

export function subscribeFavoriteSelection(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useFavoritesVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(
    () =>
      subscribeFavoriteSelection(() => setVersion((current) => current + 1)),
    [],
  );
  return version;
}
