// ──────────────────────────────────────────────────────────
// Appearance store — useSyncExternalStore + localStorage
// ──────────────────────────────────────────────────────────
//
// 2026-05-26: trimmed to a single `mode` field. The hue +
// intensity sliders were removed; tokens are now concrete HSL
// values in zeros-tokens.css. Storage key bumped v1 → v2 so any
// stale slider state from the v1 key is ignored.
//
// 2026-07-12: codeTheme resolution reworked. Storage holds only
// EXPLICIT per-variant picks (StoredAppearancePrefs.codeThemes);
// the public prefs expose the id RESOLVED for the current
// variant, re-derived on every mode change / OS appearance flip.
// The old model computed the variant default once at module load
// and then persisted it as if the user had picked it, which froze
// every light-theme user onto dark syntax colors (invisible code
// on the white editor/terminal/diff surfaces).
//
// Why useSyncExternalStore and not Context/Zustand:
//   - Theme reads happen on every render of every theme-aware
//     component. useSyncExternalStore is the React-blessed way to
//     read external state without re-render storms.
//   - Theme application has to happen BEFORE first paint to avoid
//     a flash of wrong colors. We apply on module load (synchronous
//     localStorage read) and again whenever prefs change.
//   - Cross-tab / cross-window sync via the StorageEvent listener
//     keeps multiple Zeros windows aligned without IPC plumbing.
// ──────────────────────────────────────────────────────────

import { applyTheme } from "./derive";
import {
  DEFAULT_STORED_PREFS,
  STORAGE_KEY,
  resolveThemeId,
  resolveVariant,
  themeVariantForId,
  type AppearancePrefs,
  type StoredAppearancePrefs,
  type ThemeId,
  type ThemeVariant,
} from "./prefs";
import {
  migrateLegacyCodeTheme,
  resolveCodeThemeForVariant,
} from "./code-themes";

// One-time cleanup of the v1 key (slider-era schema). Runs on module
// load; harmless on subsequent loads after the key is gone.
try {
  if (typeof localStorage !== "undefined") {
    localStorage.removeItem("zeros.appearance.v1");
  }
} catch {
  /* private mode / quota — ignore */
}

/** Validate/migrate a raw storage payload into the current stored shape.
 *  Shared by the load path and the cross-window StorageEvent path, so a
 *  stale-version window can't inject a retired mode or a legacy codeTheme
 *  shape that the load path would have migrated. */
function normalizeStored(parsed: unknown): StoredAppearancePrefs {
  if (!parsed || typeof parsed !== "object") return DEFAULT_STORED_PREFS;
  const raw = parsed as {
    mode?: unknown;
    codeTheme?: unknown;
    codeThemes?: unknown;
  };
  // "high-contrast" was removed in 2026-05-15 — any saved value of
  // that mode migrates to "system" silently. The retired variant
  // modes (orka-night / neutral / zeros-blue / zeros-shade, removed
  // 2026-07-07 when Zeros Shade became the single :root theme) fall
  // through to the default ("dark") the same way. `orka-black` is a NEW
  // id for the palette preserved in 2026-08; do not repurpose the retired
  // `orka-night` id because it represented a different historical palette.
  const rawMode = raw.mode as string | undefined;
  const mode: StoredAppearancePrefs["mode"] =
    rawMode === "high-contrast"
      ? "system"
      : rawMode === "system" ||
          rawMode === "light" ||
          rawMode === "dark" ||
          rawMode === "orka-black"
        ? rawMode
        : DEFAULT_STORED_PREFS.mode;
  // Per-variant picks. Slot values are validated lazily by
  // resolveCodeThemeForVariant (unknown/wrong-polarity id → variant default),
  // so accept any string here and let the registry clamp it. A legacy
  // single-slot string (pre-2026-07-12 schema) migrates by its appearance;
  // "default" — the value the old store froze for users who never picked —
  // migrates to "no pick" so the default finally follows the variant.
  const slots = raw.codeThemes as { dark?: unknown; light?: unknown } | null;
  const codeThemes: StoredAppearancePrefs["codeThemes"] =
    slots && typeof slots === "object"
      ? {
          ...(typeof slots.dark === "string" ? { dark: slots.dark } : {}),
          ...(typeof slots.light === "string" ? { light: slots.light } : {}),
        }
      : typeof raw.codeTheme === "string"
        ? migrateLegacyCodeTheme(raw.codeTheme)
        : {};
  return { mode, codeThemes };
}

/** The userData-persisted theme mode, exposed by the Electron preload
 *  (window.ts `appearance_set_mode` → main → additionalArguments →
 *  preload). This is the DURABLE copy: localStorage lives under the
 *  OS-purgeable Caches dir (main.ts relocates sessionData), so a cache
 *  purge would otherwise silently reset a light-theme user to dark.
 *  Explicit picks (codeThemes) aren't mirrored — after a purge they fall
 *  back to the variant defaults, which are theme-correct. */
function durableModeFallback(): StoredAppearancePrefs["mode"] | null {
  if (typeof window === "undefined") return null;
  const m = (window as { __ZEROS_APPEARANCE_MODE__?: unknown })
    .__ZEROS_APPEARANCE_MODE__;
  return m === "system" || m === "light" || m === "dark" || m === "orka-black"
    ? m
    : null;
}

function readStoredPrefs(): StoredAppearancePrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const mode = durableModeFallback();
      return mode ? { ...DEFAULT_STORED_PREFS, mode } : DEFAULT_STORED_PREFS;
    }
    return normalizeStored(JSON.parse(raw));
  } catch {
    return DEFAULT_STORED_PREFS;
  }
}

function systemPrefersDark(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return true;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Stored (explicit picks) vs public (resolved) state. `prefs.codeTheme` is
 *  always the concrete registry id whose appearance matches `variant`; both
 *  are recomputed together by refresh() so snapshots stay consistent. */
let stored: StoredAppearancePrefs = readStoredPrefs();
let prefersDark = systemPrefersDark();
let themeId: ThemeId = resolveThemeId(stored.mode, prefersDark);
let variant: ThemeVariant = themeVariantForId(themeId);
let prefs: AppearancePrefs = derivePrefs(stored, variant);
const subscribers = new Set<() => void>();

function derivePrefs(
  s: StoredAppearancePrefs,
  v: ThemeVariant,
): AppearancePrefs {
  return {
    mode: s.mode,
    codeTheme: resolveCodeThemeForVariant(s.codeThemes[v], v).id,
  };
}

function persist(next: StoredAppearancePrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* quota / private mode — fall through, next read returns defaults */
  }
}

function emit(): void {
  for (const fn of subscribers) fn();
}

/** Re-resolve variant + public prefs from `stored`, apply to the document,
 *  and notify. The prefs object is rebuilt every time, so useSyncExternalStore
 *  consumers see a fresh snapshot even when only the RESOLVED side changed
 *  (e.g. an OS appearance flip in "system" mode — mode string identical, but
 *  variant and therefore codeTheme differ). */
function refresh(): void {
  prefersDark = systemPrefersDark();
  themeId = resolveThemeId(stored.mode, prefersDark);
  variant = themeVariantForId(themeId);
  prefs = derivePrefs(stored, variant);
  applyTheme(prefs, { systemPrefersDark: prefersDark });
  emit();
}

export function getPrefs(): AppearancePrefs {
  return prefs;
}

/** The resolved app variant ("dark" | "light") — what data-theme carries.
 *  Cached alongside prefs so it's a stable useSyncExternalStore snapshot. */
export function getVariant(): ThemeVariant {
  return variant;
}

/** The concrete visual theme. Unlike getVariant(), this changes on a
 *  neutral-Dark ↔ Orka-black switch so canvas renderers can re-read tokens. */
export function getThemeId(): ThemeId {
  return themeId;
}

export function setPrefs(patch: Partial<AppearancePrefs>): void {
  if (patch.mode !== undefined) {
    stored = { ...stored, mode: patch.mode };
  }
  if (patch.codeTheme !== undefined) {
    // An explicit pick lands in the slot of the variant the user is looking
    // at (resolved AFTER any mode change in the same patch). Only this write
    // path persists a codeTheme — defaults are derived, never stored.
    const v = resolveVariant(stored.mode, systemPrefersDark());
    stored = {
      ...stored,
      codeThemes: { ...stored.codeThemes, [v]: patch.codeTheme },
    };
  }
  persist(stored);
  refresh();
}

export function subscribe(listener: () => void): () => void {
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
  };
}

// Apply on module load — runs before React mounts so first paint has
// the user's last-saved prefs (no flash of default theme).
if (typeof document !== "undefined") {
  applyTheme(prefs, { systemPrefersDark: prefersDark });
}

// Console-accessible API for ad-hoc theme testing without shipping a
// settings UI. Same hook works in dev and prod.
if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).zerosAppearance = {
    getPrefs,
    setPrefs,
    subscribe,
  };
}

// Cross-tab + system-mode reactivity.
if (typeof window !== "undefined") {
  // Reflect system theme changes when mode === "system". refresh() rebuilds
  // the prefs object (variant + resolved codeTheme change), so JS consumers
  // re-render too — not just the CSS. Previously this emitted a reference-
  // equal prefs object and every useSyncExternalStore consumer bailed,
  // leaving terminals/diffs on the old variant's resolved colors.
  if (window.matchMedia) {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const onSystemChange = () => {
      if (stored.mode === "system") refresh();
    };
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", onSystemChange);
    } else if (typeof mql.addListener === "function") {
      mql.addListener(onSystemChange);
    }
  }

  // Cross-window sync — when another Zeros window writes prefs, mirror
  // them here so both windows stay aligned without IPC plumbing. The
  // payload goes through the same normalizeStored as the load path.
  window.addEventListener("storage", (e) => {
    if (e.key !== STORAGE_KEY || !e.newValue) return;
    try {
      stored = normalizeStored(JSON.parse(e.newValue));
      refresh();
    } catch {
      /* malformed payload — ignore */
    }
  });
}
