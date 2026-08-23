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

import { readWorkspaceFile } from "../../platform/files";
import {
  ghRepositoryOwnerAvatar,
  type GithubRepositoryOwnerAvatar,
} from "../../platform/git";
import { getSetting, setSetting } from "../../platform/settings";
import {
  getActiveBridge,
  onActiveBridgeConnected,
} from "../../platform/bridge/active-bridge";
import type { Project } from "../../state/projects-store";

const STORAGE_KEY = "repository-icons-v1";
const AUTOMATIC_STORAGE_KEY = "repository-icons-auto-v1";

export const AUTOMATIC_REPOSITORY_ICON_PATHS = [
  "public/apple-touch-icon.png",
  "apple-touch-icon.png",
  "public/favicon.svg",
  "favicon.svg",
  "public/favicon.png",
  "public/icon.svg",
  "public/icon.png",
  "public/logo.svg",
  "public/logo.png",
  "favicon.png",
  "icon.svg",
  "icon.png",
  "app/icon.svg",
  "app/icon.png",
  "src/app/icon.svg",
  "src/app/icon.png",
  "public/favicon.ico",
  "favicon.ico",
  "app/favicon.ico",
  "static/favicon.ico",
  "static/icon.png",
  "src-tauri/icons/icon.png",
  "build/icon.png",
  "build/icons/icon.png",
  "resources/icon.png",
  "assets/icon.png",
  // This is a path inside the user's repository, not the Zeros source tree.
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

const SAFE_DATA_IMAGE_URL_RE =
  /^data:image\/(?:png|jpeg|gif|webp|bmp|x-icon|avif|svg\+xml);base64,/i;

function isSafeDataImageUrl(value: unknown): value is string {
  return typeof value === "string" && SAFE_DATA_IMAGE_URL_RE.test(value);
}

function isSafeHttpsImageUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.username === "" &&
      parsed.password === ""
    );
  } catch {
    return false;
  }
}

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
      if (result?.kind === "image" && isSafeDataImageUrl(result.dataUrl)) {
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
    if (avatar && isSafeHttpsImageUrl(avatar.avatarUrl)) {
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
// Detection is expensive (many workspace-file probes plus a GitHub API
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

function isAutomaticRepositoryIcon(
  value: unknown,
): value is AutomaticRepositoryIcon {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AutomaticRepositoryIcon>;
  if (candidate.imageUrl === null) return candidate.source === null;
  if (typeof candidate.imageUrl !== "string" || !candidate.source) {
    return false;
  }
  if (candidate.imageUrl.length > MAX_PERSISTED_ICON_CHARS) return false;

  const source = candidate.source as Record<string, unknown>;
  if (source.kind === "repository-file") {
    const sourcePath = source.path;
    return (
      isSafeDataImageUrl(candidate.imageUrl) &&
      typeof sourcePath === "string" &&
      sourcePath.length > 0 &&
      !sourcePath.startsWith("/") &&
      !sourcePath.split("/").includes("..")
    );
  }
  return (
    source.kind === "github-avatar" &&
    isSafeHttpsImageUrl(candidate.imageUrl) &&
    typeof source.login === "string" &&
    source.login.length > 0 &&
    (source.ownerType === "user" ||
      source.ownerType === "org" ||
      source.ownerType === null)
  );
}

function isStoredAutomaticIcon(value: unknown): value is StoredAutomaticIcon {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StoredAutomaticIcon>;
  if (typeof candidate.bridged !== "boolean") return false;
  if (
    typeof candidate.updatedAt !== "number" ||
    !Number.isFinite(candidate.updatedAt)
  ) {
    return false;
  }
  return isAutomaticRepositoryIcon(candidate.icon);
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

const AUTOMATIC_ICON_WARM_CONCURRENCY = 3;

/** Warm every registered repository without issuing an unbounded burst of
 * file/GitHub reads. Duplicate root+origin identities share one job, and the
 * normal automatic cache still deduplicates against icons already mounted by
 * visible surfaces. */
export async function warmAutomaticRepositoryIcons(
  projects: readonly Pick<Project, "repoRoot" | "originUrl">[],
): Promise<void> {
  const targetsByKey = new Map<string, AutomaticIconTarget>();
  for (const project of projects) {
    const target = automaticIconTarget(project.repoRoot, project.originUrl);
    if (target.repoRoot) targetsByKey.set(target.key, target);
  }
  const targets = Array.from(targetsByKey.values());
  let cursor = 0;

  const worker = async () => {
    while (cursor < targets.length) {
      const target = targets[cursor];
      cursor += 1;
      if (!target) continue;
      ensureAutomaticIcon(target);
      // A visible surface may have started a provisional bridge-less read just
      // before startup warming. Its completion synchronously schedules the
      // trustworthy bridge-connected retry; keep that retry inside this
      // worker's concurrency slot and do not report the repository as warm
      // until the complete chain settles.
      let pending = automaticInflight.get(target.key);
      while (pending) {
        await pending;
        const followup = automaticInflight.get(target.key);
        if (followup === pending) break;
        pending = followup;
      }
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(AUTOMATIC_ICON_WARM_CONCURRENCY, targets.length) },
      worker,
    ),
  );
}

/** App-lifecycle owner for automatic icons. Persisted snapshots paint
 * synchronously; after the bridge connects, every registered repository gets
 * one bounded, idle background revalidation for this app session. */
export function useWarmAutomaticRepositoryIcons(
  projects: readonly Pick<Project, "repoRoot" | "originUrl">[],
): void {
  useEffect(() => {
    let disposed = false;
    let cancelScheduled = () => {};
    const schedule = () => {
      cancelScheduled();
      const warm = () => {
        if (!disposed) void warmAutomaticRepositoryIcons(projects);
      };
      if (typeof window.requestIdleCallback === "function") {
        const id = window.requestIdleCallback(warm, { timeout: 1_000 });
        cancelScheduled = () => window.cancelIdleCallback(id);
      } else {
        const id = window.setTimeout(warm, 0);
        cancelScheduled = () => window.clearTimeout(id);
      }
    };
    const stop = onActiveBridgeConnected(schedule);
    return () => {
      disposed = true;
      cancelScheduled();
      stop();
    };
  }, [projects]);
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
