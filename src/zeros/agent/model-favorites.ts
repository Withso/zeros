// ──────────────────────────────────────────────────────────
// Favorite model per agent family (the New-Chat default model)
// ──────────────────────────────────────────────────────────
//
// The user can ★ a model in the composer's model dropdown. The starred
// model becomes the DEFAULT model for new chats of that agent — e.g. star
// "Opus 4.8" and every new Claude chat opens on it. EXACTLY ONE
// favorite per agent FAMILY (claude / codex / cursor), since the model
// catalog is family-scoped (a "claude" favorite applies to any claude-*
// agent id).
//
// 2026-07 spec: every family ALWAYS has an effective favorite. When the
// user hasn't starred one, the catalog's `defaultFavorites` fallback
// applies (claude → Opus 4.8, codex → 5.6 Sol, cursor → Composer 2.5)
// — see effectiveFavoriteModel(). Un-starring a user pick reverts to that
// fallback; the fallback itself can't be un-starred (there is no
// "no favorite" state).
//
// Mirrors default-agent.ts: getSetting/setSetting persistence + a small
// pub/sub bus so every open model dropdown / settings surface re-renders
// in sync when the star is toggled from any surface. Lives in its own
// module so composer-pills.tsx can stay React-component-only (Vite Fast
// Refresh).
// ──────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";

import { getSetting, setSetting } from "../../native/settings";
import {
  agentFamily,
  defaultFavoriteModelFor,
  modelsForAgent,
} from "./model-catalog";

/** Storage key — a map of agent family → favorite model value. */
const FAVORITE_MODELS_KEY = "favorite-models-by-family";

type FavoriteMap = Record<string, string>;

function readMap(): FavoriteMap {
  const raw = getSetting<FavoriteMap | null>(FAVORITE_MODELS_KEY, null);
  return raw && typeof raw === "object" ? raw : {};
}

/** The USER-starred model value for an agent's family, or null when the user
 *  hasn't starred one. Most callers want {@link effectiveFavoriteModel} (which
 *  applies the catalog fallback); this raw read exists for persistence
 *  round-trips (settings.toml mirror/hydrate) where "unset" must stay unset. */
export function getFavoriteModel(agentId: string | null | undefined): string | null {
  const fam = agentFamily(agentId ?? null);
  if (!fam) return null;
  const v = readMap()[fam];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** The favorite model new chats of this agent open on — the user's star when
 *  set AND still curated, else the catalog's per-family fallback (claude →
 *  Opus 4.8, codex → 5.6 Sol, cursor → Composer 2.5). Null only for an
 *  unknown family. Every spawn path + star UI resolves through this so "one
 *  favorite per agent" always holds.
 *
 *  The curated-membership check matters after a catalog update: a star saved
 *  against a since-retired id (e.g. `claude-opus-4-7`) would otherwise stamp
 *  every new chat with a model the agent rejects. The stale star is left in
 *  storage (a future catalog could revive the id); resolution just ignores
 *  it. */
export function effectiveFavoriteModel(
  agentId: string | null | undefined,
): string | null {
  const fam = agentFamily(agentId ?? null);
  if (!fam) return null;
  const star = getFavoriteModel(agentId);
  if (star && modelsForAgent(fam, null).some((m) => m.value === star)) {
    return star;
  }
  return defaultFavoriteModelFor(fam);
}

/** Set (or clear, with null) the favorite model for an agent's family. */
export function setFavoriteModel(
  agentId: string | null | undefined,
  modelValue: string | null,
): void {
  const fam = agentFamily(agentId ?? null);
  if (!fam) return;
  const map = readMap();
  if (modelValue) map[fam] = modelValue;
  else delete map[fam];
  setSetting(FAVORITE_MODELS_KEY, map);
  notify();
}

// ── Pub/sub bus (mirrors default-agent.ts) ───────────────

type Listener = () => void;
const listeners = new Set<Listener>();

function notify(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* listeners shouldn't throw; keep going */
    }
  }
}

/** Hook: a monotonically-increasing version that bumps on ANY favorite
 *  change, for surfaces that read favorites for SEVERAL families at once
 *  (the composer's agent-model dropdown renders all three rails) — a
 *  per-family hook can't be called in a loop. Read the values directly via
 *  getFavoriteModel/effectiveFavoriteModel; this just re-renders you. */
export function useFavoritesVersion(): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    const sync = () => setV((n) => n + 1);
    listeners.add(sync);
    return () => {
      listeners.delete(sync);
    };
  }, []);
  return v;
}

/** Hook: the favorite model for `agentId`'s family + a toggle. `favorite` is
 *  the EFFECTIVE favorite (user ★, else the catalog fallback) — the model the
 *  star UI marks and new chats open on; there is always exactly one per
 *  family. Re-renders whenever any caller of setFavoriteModel() fires. */
export function useFavoriteModel(agentId: string | null | undefined): {
  favorite: string | null;
  toggleFavorite: (modelValue: string) => void;
} {
  const [favorite, setFav] = useState<string | null>(() =>
    effectiveFavoriteModel(agentId),
  );

  useEffect(() => {
    const sync = () => setFav(effectiveFavoriteModel(agentId));
    sync();
    listeners.add(sync);
    return () => {
      listeners.delete(sync);
    };
  }, [agentId]);

  /** Radio semantics — exactly one favorite per family. Starring a model
   *  makes it the favorite; re-clicking a USER star clears it (reverting to
   *  the catalog fallback, which stays starred). The fallback itself can't
   *  be un-starred: there is no "no favorite" state. */
  const toggleFavorite = useCallback(
    (modelValue: string) => {
      const userStar = getFavoriteModel(agentId);
      setFavoriteModel(agentId, userStar === modelValue ? null : modelValue);
    },
    [agentId],
  );

  return { favorite, toggleFavorite };
}
