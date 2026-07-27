// ──────────────────────────────────────────────────────────
// Internal features — allowlisted-account-only feature flags
// ──────────────────────────────────────────────────────────
//
// NOT experimental features. Experimental (experimental-features.ts) is
// visible to every user as an opt-in; Internal is invisible to everyone
// except the accounts in INTERNAL_USER_EMAILS. These features may never
// ship to users — they exist for maintainers to debug/dogfood the app
// (Settings → Internal, gated in settings-page.tsx `availableSections`).
//
// Who counts as internal comes from the DATABASE: `users.staff_role`,
// surfaced on `GET /v1/me` and cached by the team store. It used to be a
// build-time email allowlist (`VITE_INTERNAL_USER_EMAILS`), which was wrong
// in three ways: Vite inlines VITE_* into the renderer bundle, so the
// maintainer addresses were readable by anyone who unzipped app.asar from a
// public build; changing who was internal meant a full rebuild and
// re-release; and a build that forgot the secret silently lost the tab.
// A SQL UPDATE now does it, effective on the acting user's next request.
//
// Non-negotiable rules:
//   1. Every runtime surface gates on `useInternalFeatureActive(...)` /
//      `isInternalFeatureActive(...)` — staff AND flag — never on the raw
//      flag alone. localStorage is user-editable; the staff check on top
//      means a forged flag still does nothing for an ordinary account.
//   2. No discoverability leaks: internal features never appear in the
//      ⌘/ shortcuts catalog, menus, tooltips, or any surface a
//      non-internal user can see.
//   3. The role is resolved SERVER-side from Postgres against the verified
//      Auth0 token (backend/src/auth.ts `ensureUser` runs per request) and
//      is never read from a JWT claim, so revoking staff takes effect
//      immediately rather than at token expiry. Signed out, control plane
//      unconfigured, or fetch not yet landed ⇒ null ⇒ everything internal
//      is off. Fail-closed in every direction.
//   4. This remains a CLIENT-side gate, and it is only sound because the
//      current flags reveal nothing privileged (`copyLogs` copies already-
//      scrubbed logs to the user's own clipboard). The moment an internal
//      feature gains real power, the SERVER must check `staff_role` on the
//      endpoint behind it. Reading the role from the DB is what makes that
//      possible; the old build-time allowlist never could.
//
// Per-app scoping comes free: flags persist to localStorage, and each
// channel (Zeros / Zeros Alpha / Zeros Beta / Zeros Dev, plus per-worktree
// dev instances) runs with its own userData dir → its own localStorage
// (src/engine/db/paths.ts). Enabling a flag in Beta therefore never
// affects Production, and vice versa — exactly the per-app control the
// Internal tab promises. The staff role, by contrast, is one row in one
// database and is therefore the same in every channel.
//
// Store mechanics mirror experimental-features.ts: module-level snapshot
// + useSyncExternalStore so a toggle propagates to mounted consumers in
// the same render cycle, plus a "storage" listener for multi-window sync.

import { useCallback, useSyncExternalStore } from "react";

import { getTeamStoreState, useTeams } from "../team/team-store";

// ── Who counts as internal ──────────────────────────────

/** True when the cached `/v1/me` reports a staff role. Synchronous read for
 *  non-React call sites; the store is cleared on sign-out, so this cannot
 *  return account A's answer to account B.
 *
 *  Null in every unresolved state — signed out, control plane unconfigured,
 *  first fetch still in flight — because "not yet known" must behave as
 *  "not internal", never the reverse. */
export function isInternalUser(): boolean {
  return getTeamStoreState().me?.user.staffRole != null;
}

/** Hook: is the signed-in user staff? Gates the Internal settings tab and
 *  composes into `useInternalFeatureActive`. Subscribes to the team store, so
 *  the tab appears/disappears as the role resolves or the account changes.
 *  `useTeams` is single-flight, so calling it here costs no extra request. */
export function useIsInternalUser(): boolean {
  const { me } = useTeams();
  return me?.user.staffRole != null;
}

// ── The flags ───────────────────────────────────────────

/** The set of internal feature flags.
 *  - `copyLogs` — ⇧⌘L copies the scrubbed recent-log tail (the exact
 *    bytes a feedback submission shares) to the clipboard. */
export type InternalFeature = "copyLogs";

const STORAGE_KEY = "zeros.internalFeatures";

type PersistedShape = Partial<Record<InternalFeature, boolean>>;

function readPersisted(): PersistedShape {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as PersistedShape)
      : {};
  } catch {
    return {};
  }
}

function writePersisted(next: PersistedShape): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* storage quota / private mode — non-fatal */
  }
}

// ── Shared module-level store ───────────────────────────
let current: PersistedShape = readPersisted();
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function getSnapshot(): PersistedShape {
  return current;
}

/** Read the RAW flag synchronously. Off by default. UI-only (the Internal
 *  panel's switches); runtime behavior must use `isInternalFeatureActive`
 *  so the allowlist is enforced. */
export function isInternalFeatureEnabled(feature: InternalFeature): boolean {
  return current[feature] === true;
}

/** Flip a flag and notify every subscriber. Always swaps the snapshot
 *  reference so useSyncExternalStore consumers re-render. */
export function setInternalFeatureEnabled(
  feature: InternalFeature,
  on: boolean,
): void {
  current = { ...current, [feature]: on };
  writePersisted(current);
  emit();
}

/** The effective gate for non-React call sites: staff AND flag on. Reads the
 *  role from the team store itself rather than taking it as an argument — the
 *  old signature took the session email, which invited exactly the bug it
 *  warned about (a caller caching a stale identity). */
export function isInternalFeatureActive(feature: InternalFeature): boolean {
  return isInternalUser() && isInternalFeatureEnabled(feature);
}

// Cross-window sync — Electron devtools-in-a-separate-window and any
// future multi-window setup (mirrors experimental-features.ts).
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== STORAGE_KEY) return;
    current = readPersisted();
    emit();
  });
}

/** Hook: `[on, setOn]` for one internal feature's RAW flag. For the
 *  Internal panel's switches only — runtime consumers gate on
 *  `useInternalFeatureActive` instead. */
export function useInternalFeature(
  feature: InternalFeature,
): [boolean, (on: boolean) => void] {
  const persisted = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const on = persisted[feature] === true;
  const set = useCallback(
    (next: boolean) => setInternalFeatureEnabled(feature, next),
    [feature],
  );
  return [on, set];
}

/** Hook: the EFFECTIVE gate — allowlisted account AND flag on. This is
 *  the only sanctioned way to enable an internal feature's runtime
 *  surface (hotkeys, panels, commands). Reacts to both sign-in/out and
 *  flag flips. */
export function useInternalFeatureActive(feature: InternalFeature): boolean {
  const internalUser = useIsInternalUser();
  const [on] = useInternalFeature(feature);
  return internalUser && on;
}
