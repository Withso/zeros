// ──────────────────────────────────────────────────────────
// Repository icons — automatic repo-file discovery + local overrides
// ──────────────────────────────────────────────────────────
//
// Automatic discovery walks a fixed, documented list of well-known repo icon
// files (AUTOMATIC_REPOSITORY_ICON_PATHS), highest-fidelity first. Custom
// Lucide/emoji/upload choices live outside Project records so engine project
// refreshes cannot overwrite them and large image data never enters repo sync.
// ──────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";

import { readWorkspaceFile } from "../../native/files";
import {
  ghRepositoryOwnerAvatar,
  type GithubRepositoryOwnerAvatar,
} from "../../native/git";
import { getSetting, setSetting } from "../../native/settings";
import {
  getActiveBridge,
  onActiveBridgeConnected,
} from "../bridge/active-bridge";
import type { Project } from "./projects-store";

const STORAGE_KEY = "repository-icons-v1";
const AUTOMATIC_STORAGE_KEY = "repository-icons-auto-v1";

export const AUTOMATIC_REPOSITORY_ICON_PATHS = [
  "public/apple-touch-icon.png",
  "apple-touch-icon.png",
  "public/favicon.svg",
  "favicon.svg",
  "public/favicon.png",
  "public/icon.png",
  "public/logo.png",
  "favicon.png",
  "app/icon.png",
  "src/app/icon.png",
  "public/favicon.ico",
  "favicon.ico",
  "app/favicon.ico",
  "static/favicon.ico",
  "src-tauri/icons/icon.png",
  "assets/icon.png",
  "src/assets/icon.png",
] as const;

export type RepositoryIconChoice =
  | { kind: "lucide"; value: string }
  | { kind: "emoji"; value: string }
  | { kind: "upload"; dataUrl: string };

export interface AutomaticRepositoryIcon {
  imageUrl: string | null;
  source:
    | { kind: "repository-file"; path: string }
    | {
        kind: "github-avatar";
        login: string;
        ownerType: "user" | "org" | null;
      }
    | null;
}

const EMPTY_AUTOMATIC_ICON: AutomaticRepositoryIcon = {
  imageUrl: null,
  source: null,
};

type StoredChoices = Record<string, RepositoryIconChoice>;

function storageKey(repoRoot: string): string {
  return repoRoot.trim().replace(/\/+$/, "");
}

function isChoice(value: unknown): value is RepositoryIconChoice {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RepositoryIconChoice> & {
    value?: unknown;
    dataUrl?: unknown;
  };
  if (
    (candidate.kind === "lucide" || candidate.kind === "emoji") &&
    typeof candidate.value === "string" &&
    candidate.value.length > 0
  ) {
    return true;
  }
  return (
    candidate.kind === "upload" &&
    typeof candidate.dataUrl === "string" &&
    /^data:image\/(?:png|jpeg);base64,/i.test(candidate.dataUrl)
  );
}

function loadChoices(): StoredChoices {
  const raw = getSetting<unknown>(STORAGE_KEY, {});
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw).filter(
      (entry): entry is [string, RepositoryIconChoice] => isChoice(entry[1]),
    ),
  );
}

const choiceListeners = new Set<(repoRoot: string) => void>();

export function getRepositoryIconChoice(
  repoRoot: string,
): RepositoryIconChoice | null {
  return loadChoices()[storageKey(repoRoot)] ?? null;
}

export function setRepositoryIconChoice(
  repoRoot: string,
  choice: RepositoryIconChoice | null,
): void {
  const key = storageKey(repoRoot);
  const choices = loadChoices();
  if (choice) choices[key] = choice;
  else delete choices[key];
  setSetting(STORAGE_KEY, choices);
  for (const listener of choiceListeners) listener(key);
}

export function useRepositoryIconChoice(
  repoRoot: string,
): RepositoryIconChoice | null {
  const key = storageKey(repoRoot);
  const [choice, setChoice] = useState<RepositoryIconChoice | null>(() =>
    getRepositoryIconChoice(key),
  );

  useEffect(() => {
    const sync = (changedRoot: string) => {
      if (changedRoot === key) setChoice(getRepositoryIconChoice(key));
    };
    choiceListeners.add(sync);
    setChoice(getRepositoryIconChoice(key));
    return () => {
      choiceListeners.delete(sync);
    };
  }, [key]);

  return choice;
}

export type RepositoryIconReader = (
  repoRoot: string,
  relativePath: string,
) => Promise<{ kind?: string; dataUrl?: string } | null>;

export type RepositoryOwnerAvatarReader = (
  repoRoot: string,
) => Promise<GithubRepositoryOwnerAvatar | null>;

/** Resolve the first readable repository image in the documented lookup order,
 *  then the GitHub repository owner's avatar, then no image. Both readers are
 *  injectable so the complete priority and failure contract is unit-testable. */
export async function detectAutomaticRepositoryIcon(
  repoRoot: string,
  reader: RepositoryIconReader = readWorkspaceFile,
  avatarReader: RepositoryOwnerAvatarReader = ghRepositoryOwnerAvatar,
): Promise<AutomaticRepositoryIcon> {
  for (const sourcePath of AUTOMATIC_REPOSITORY_ICON_PATHS) {
    try {
      const result = await reader(repoRoot, sourcePath);
      if (result?.kind === "image" && result.dataUrl) {
        return {
          imageUrl: result.dataUrl,
          source: { kind: "repository-file", path: sourcePath },
        };
      }
    } catch {
      // A missing/unreadable candidate is expected; continue in priority order.
    }
  }

  try {
    const avatar = await avatarReader(repoRoot);
    if (avatar?.avatarUrl) {
      return {
        imageUrl: avatar.avatarUrl,
        source: {
          kind: "github-avatar",
          login: avatar.login,
          ownerType: avatar.type,
        },
      };
    }
  } catch {
    // GitHub fallback is optional: offline/auth/API failures use the initial.
  }
  return EMPTY_AUTOMATIC_ICON;
}

interface AutomaticIconTarget {
  repoRoot: string;
  originUrl: string;
  key: string;
}

/** Include the current origin in the cache identity. A repository may gain an
 *  origin after being opened or switch owners; neither transition should leave
 *  an earlier initial/avatar cached under the same local path. */
function automaticIconTarget(
  repoRoot: string,
  originUrl: string | null | undefined,
): AutomaticIconTarget {
  const root = storageKey(repoRoot);
  const origin = originUrl?.trim() ?? "";
  // NUL cannot occur in a filesystem path or Git remote URL, so unlike a
  // newline it is a collision-safe separator even for unusual POSIX names.
  return { repoRoot: root, originUrl: origin, key: `${root}\0${origin}` };
}

// ── Automatic icon cache ─────────────────────────────────
//
// Detection is expensive (up to 17 workspace-file probes plus a GitHub API
// call), and the result almost never changes. So results — including "no icon
// found" — are persisted across launches and every surface renders straight
// from cache. Detection reruns only when:
//   • the key has never been detected with a usable bridge (early native-only
//     scans before BridgeProvider connects can't see workspace files or
//     GitHub, so their misses are provisional),
//   • the first mount of a key in an app session (one background
//     revalidation; listeners fire only if the result actually changed),
//   • the user explicitly refreshes from the icon dialog.
// Opening a dropdown, switching workspaces, or re-rendering a sidebar row
// never refetches.

interface AutomaticIconState {
  icon: AutomaticRepositoryIcon | null;
  /** The last completed detection ran with a connected bridge; bridge-less
   *  results are provisional and rerun when the bridge becomes usable. */
  bridged: boolean;
  /** A bridged detection completed during this app session. */
  validated: boolean;
  refreshing: boolean;
}

interface StoredAutomaticIcon {
  icon: AutomaticRepositoryIcon;
  bridged: boolean;
  updatedAt: number;
}

/** Data-url icons are small (favicons/touch icons), but cap what we persist so
 *  an unusually large asset cannot crowd localStorage. Oversized results still
 *  live in the in-memory cache for the session. */
const MAX_PERSISTED_ICON_CHARS = 300_000;
const MAX_PERSISTED_ICONS = 48;

function isStoredAutomaticIcon(value: unknown): value is StoredAutomaticIcon {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StoredAutomaticIcon>;
  if (typeof candidate.bridged !== "boolean") return false;
  if (typeof candidate.updatedAt !== "number") return false;
  const icon = candidate.icon;
  if (!icon || typeof icon !== "object") return false;
  return icon.imageUrl === null || typeof icon.imageUrl === "string";
}

let storedAutomaticIcons: Record<string, StoredAutomaticIcon> | null = null;

function loadStoredAutomaticIcons(): Record<string, StoredAutomaticIcon> {
  if (storedAutomaticIcons) return storedAutomaticIcons;
  const raw = getSetting<unknown>(AUTOMATIC_STORAGE_KEY, {});
  storedAutomaticIcons =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? Object.fromEntries(
          Object.entries(raw).filter(
            (entry): entry is [string, StoredAutomaticIcon] =>
              isStoredAutomaticIcon(entry[1]),
          ),
        )
      : {};
  return storedAutomaticIcons;
}

function persistAutomaticIcon(key: string, entry: StoredAutomaticIcon): void {
  const stored = loadStoredAutomaticIcons();
  const iconSize = entry.icon.imageUrl?.length ?? 0;
  if (iconSize > MAX_PERSISTED_ICON_CHARS) delete stored[key];
  else stored[key] = entry;
  const keys = Object.keys(stored);
  if (keys.length > MAX_PERSISTED_ICONS) {
    keys
      .sort((a, b) => (stored[b]?.updatedAt ?? 0) - (stored[a]?.updatedAt ?? 0))
      .slice(MAX_PERSISTED_ICONS)
      .forEach((staleKey) => delete stored[staleKey]);
  }
  setSetting(AUTOMATIC_STORAGE_KEY, stored);
}

const automaticStates = new Map<string, AutomaticIconState>();
const automaticInflight = new Map<string, Promise<void>>();
const automaticForceQueued = new Set<string>();
const automaticListeners = new Set<(targetKey: string) => void>();
const bridgeSubscriptions = new Map<
  string,
  { consumers: number; unsubscribe: () => void }
>();
const MAX_AUTOMATIC_ICON_STATES = 64;

function pruneAutomaticIconStates(protectedKey?: string): void {
  if (automaticStates.size <= MAX_AUTOMATIC_ICON_STATES) return;
  for (const key of automaticStates.keys()) {
    if (
      key === protectedKey ||
      automaticInflight.has(key) ||
      bridgeSubscriptions.has(key)
    ) {
      continue;
    }
    automaticStates.delete(key);
    automaticForceQueued.delete(key);
    if (automaticStates.size <= MAX_AUTOMATIC_ICON_STATES) break;
  }
}

function automaticIconState(key: string): AutomaticIconState {
  let state = automaticStates.get(key);
  if (!state) {
    const stored = loadStoredAutomaticIcons()[key];
    state = {
      icon: stored?.icon ?? null,
      bridged: stored?.bridged ?? false,
      validated: false,
      refreshing: false,
    };
    automaticStates.set(key, state);
    // Protect the just-created handshake entry; a caller may subscribe or begin
    // detection immediately after this read.
    pruneAutomaticIconStates(key);
  }
  return state;
}

function notifyAutomaticIcon(key: string): void {
  for (const listener of automaticListeners) listener(key);
}

function sameAutomaticIcon(
  a: AutomaticRepositoryIcon | null,
  b: AutomaticRepositoryIcon,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function bridgeIsConnected(): boolean {
  return getActiveBridge()?.status === "connected";
}

/** Run detection for `target` unless the cached result is already trustworthy.
 *  Stale-while-revalidate: the current icon stays visible for the whole read,
 *  and listeners repaint only for genuine state changes. */
function ensureAutomaticIcon(
  target: AutomaticIconTarget,
  options: { force?: boolean } = {},
): void {
  const state = automaticIconState(target.key);
  if (!options.force && state.validated) return;

  if (automaticInflight.has(target.key)) {
    // A forced refresh must not be swallowed by an in-flight read that began
    // earlier (possibly bridge-less); queue exactly one follow-up.
    if (options.force && !automaticForceQueued.has(target.key)) {
      automaticForceQueued.add(target.key);
      void automaticInflight.get(target.key)?.finally(() => {
        automaticForceQueued.delete(target.key);
        ensureAutomaticIcon(target, { force: true });
      });
    }
    return;
  }

  const bridgedAtStart = bridgeIsConnected();
  if (!state.refreshing) {
    state.refreshing = true;
    notifyAutomaticIcon(target.key);
  }

  const pending = detectAutomaticRepositoryIcon(target.repoRoot)
    .then((result) => {
      const changed = !sameAutomaticIcon(state.icon, result);
      // A bridge-less scan cannot see workspace files or GitHub, so its
      // (usually empty) result must never replace a previously bridged one.
      const trustworthy = bridgedAtStart || !state.bridged;
      if (changed && trustworthy) state.icon = result;
      if (trustworthy) state.bridged = bridgedAtStart;
      state.validated = bridgedAtStart;
      state.refreshing = false;
      notifyAutomaticIcon(target.key);
      if (bridgedAtStart) {
        persistAutomaticIcon(target.key, {
          icon: state.icon ?? result,
          bridged: true,
          updatedAt: Date.now(),
        });
      }
    })
    .catch(() => {
      state.refreshing = false;
      notifyAutomaticIcon(target.key);
    })
    .finally(() => {
      automaticInflight.delete(target.key);
      // The bridge connected while a bridge-less scan was in flight: rerun so
      // an early miss cannot stick around as a cached fallback.
      if (!state.validated && bridgeIsConnected()) {
        ensureAutomaticIcon(target);
      }
      pruneAutomaticIconStates(target.key);
    });
  automaticInflight.set(target.key, pending);
}

/** Share one active-bridge listener per repository even when the same icon is
 *  rendered in a trigger, an open menu, and the dialog simultaneously. The
 *  callback is an ensure — not an invalidation — so mounting an icon while the
 *  bridge is already connected costs nothing once the key is validated. */
function subscribeToBridgeForIcon(target: AutomaticIconTarget): () => void {
  const existing = bridgeSubscriptions.get(target.key);
  if (existing) {
    existing.consumers += 1;
  } else {
    bridgeSubscriptions.set(target.key, {
      consumers: 1,
      unsubscribe: onActiveBridgeConnected(() => ensureAutomaticIcon(target)),
    });
  }

  return () => {
    const subscription = bridgeSubscriptions.get(target.key);
    if (!subscription) return;
    subscription.consumers -= 1;
    if (subscription.consumers > 0) return;
    subscription.unsubscribe();
    bridgeSubscriptions.delete(target.key);
    pruneAutomaticIconStates();
  };
}

/** Force a full re-detection (icon dialog's refresh button). The current icon
 *  stays visible until the new result lands. */
export function refreshAutomaticRepositoryIcon(
  repoRoot: string,
  originUrl?: string | null,
): void {
  const target = automaticIconTarget(repoRoot, originUrl);
  const state = automaticIconState(target.key);
  state.validated = false;
  ensureAutomaticIcon(target, { force: true });
}

/** Non-hook ensure — usable for prefetching (e.g. warming a menu's icons). */
export function ensureAutomaticRepositoryIcon(
  repoRoot: string,
  originUrl?: string | null,
): void {
  ensureAutomaticIcon(automaticIconTarget(repoRoot, originUrl));
}

/** Non-hook cache read; null until the first detection (or persisted result)
 *  for this repository lands. */
export function getAutomaticRepositoryIcon(
  repoRoot: string,
  originUrl?: string | null,
): AutomaticRepositoryIcon | null {
  return automaticIconState(automaticIconTarget(repoRoot, originUrl).key).icon;
}

interface AutomaticIconSnapshot {
  icon: AutomaticRepositoryIcon | null;
  refreshing: boolean;
}

function automaticIconSnapshot(key: string): AutomaticIconSnapshot {
  const state = automaticIconState(key);
  return { icon: state.icon, refreshing: state.refreshing };
}

export function useAutomaticRepositoryIcon(
  repoRoot: string,
  originUrl: string | null,
  enabled = true,
): AutomaticRepositoryIcon & {
  loading: boolean;
  refreshing: boolean;
  refresh: () => void;
} {
  const target = automaticIconTarget(repoRoot, originUrl);
  const targetKey = target.key;
  const targetRepoRoot = target.repoRoot;
  const targetOriginUrl = target.originUrl;
  const [resolved, setResolved] = useState<{
    targetKey: string;
    snapshot: AutomaticIconSnapshot;
  }>(() => ({
    targetKey,
    snapshot: automaticIconSnapshot(targetKey),
  }));
  // A hook instance is reused when the selected repository/origin changes.
  // Never expose the previous target's icon during the render before the effect
  // below attaches to the new target.
  const snapshot =
    resolved.targetKey === targetKey
      ? resolved.snapshot
      : automaticIconSnapshot(targetKey);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const sync = (changedTarget: string) => {
      if (changedTarget !== targetKey || !active) return;
      setResolved({ targetKey, snapshot: automaticIconSnapshot(targetKey) });
    };
    automaticListeners.add(sync);
    sync(targetKey);
    const stopBridgeListener = subscribeToBridgeForIcon({
      key: targetKey,
      repoRoot: targetRepoRoot,
      originUrl: targetOriginUrl,
    });
    // No-op when this key is already validated for the session; otherwise a
    // single deduplicated background read (persisted icons stay on screen).
    ensureAutomaticIcon({
      key: targetKey,
      repoRoot: targetRepoRoot,
      originUrl: targetOriginUrl,
    });
    return () => {
      active = false;
      automaticListeners.delete(sync);
      stopBridgeListener();
    };
  }, [enabled, targetKey, targetOriginUrl, targetRepoRoot]);

  const refresh = useCallback(
    () => refreshAutomaticRepositoryIcon(targetRepoRoot, targetOriginUrl),
    [targetOriginUrl, targetRepoRoot],
  );

  return {
    ...(snapshot.icon ?? EMPTY_AUTOMATIC_ICON),
    loading: enabled && snapshot.icon === null,
    refreshing: snapshot.refreshing,
    refresh,
  };
}

/** Test-only: drop all in-memory and persisted automatic-icon state. */
export function resetAutomaticRepositoryIconsForTest(): void {
  automaticStates.clear();
  automaticInflight.clear();
  automaticForceQueued.clear();
  automaticListeners.clear();
  for (const subscription of bridgeSubscriptions.values()) {
    subscription.unsubscribe();
  }
  bridgeSubscriptions.clear();
  storedAutomaticIcons = null;
}

/** Test-only runtime bound assertion. */
export function automaticRepositoryIconStateCountForTests(): number {
  return automaticStates.size;
}

export const automaticRepositoryIconStateLimit = MAX_AUTOMATIC_ICON_STATES;

export function useResolvedRepositoryIcon(project: Project): {
  choice: RepositoryIconChoice | null;
  automatic: AutomaticRepositoryIcon;
  loading: boolean;
} {
  const choice = useRepositoryIconChoice(project.repoRoot);
  const automatic = useAutomaticRepositoryIcon(
    project.repoRoot,
    project.originUrl,
    choice === null,
  );
  return {
    choice,
    automatic,
    loading: choice === null && automatic.loading,
  };
}
