// ──────────────────────────────────────────────────────────
// Last-confirmed Changes snapshots
// ──────────────────────────────────────────────────────────
//
// Git is engine-owned server state, but a validated exact-key snapshot is safe
// to paint while that same key revalidates. Persist only list metadata (never
// patches) so cold app opens can restore the Changes sidebar without consuming
// the origin quota with diff bodies. Empty snapshots remove their persisted
// entry: after an offline edit, a cold boot must wait for live Git before it can
// claim "No changes".

import type { FileChangeStatus } from "@/renderer/platform/git";
import { getSetting, removeSetting, setSetting } from "@/renderer/platform/settings";

import type { ChangedFile } from "./changes-parse";
import type { Scope } from "./changes-scope";

export type ChangesSectionKind = "changes" | "committed";

export interface CachedChangesSection {
  kind: ChangesSectionKind;
  title: string | null;
  files: ChangedFile[];
}

interface StoredSectionEntry {
  workspaceId: string;
  scope: Scope;
  savedAt: number;
  sections: CachedChangesSection[];
}

interface StoredCountEntry {
  workspaceId: string;
  savedAt: number;
  count: number;
  /** Reject v1 entries written from the old porcelain-bucket union. */
  basis: "all";
}

interface StoredPayload {
  version: 1;
  sections: StoredSectionEntry[];
  counts: StoredCountEntry[];
}

const STORAGE_KEY = "changes-snapshots:v1";
const MAX_SECTION_KEYS = 48;
const MAX_COUNT_KEYS = 64;
const MAX_SECTIONS_PER_KEY = 4;
const MAX_FILES_PER_KEY = 2_000;
const MAX_IDENTITY_CHARS = 4_096;
const MAX_SERIALIZED_CHARS = 1_250_000;
const VALID_STATUSES = new Set<FileChangeStatus>([
  "added",
  "modified",
  "deleted",
  "renamed",
  "untracked",
  "conflicted",
]);
let lastSavedAt = 0;

function nextSavedAt(): number {
  lastSavedAt = Math.max(Date.now(), lastSavedAt + 1);
  return lastSavedAt;
}

function boundedString(value: unknown): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_IDENTITY_CHARS
    ? value
    : null;
}

function optionalString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  return boundedString(value);
}

function optionalBoolean(value: unknown): boolean | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "boolean" ? value : null;
}

function finiteCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function sanitizeScope(value: unknown): Scope | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    raw.kind === "all" ||
    raw.kind === "uncommitted" ||
    raw.kind === "staged" ||
    raw.kind === "unstaged"
  ) {
    return { kind: raw.kind };
  }
  if (raw.kind !== "commit") return null;
  const sha = boundedString(raw.sha);
  const message =
    typeof raw.message === "string" && raw.message.length <= MAX_IDENTITY_CHARS
      ? raw.message
      : "";
  return sha ? { kind: "commit", sha, message } : null;
}

function sanitizeFile(value: unknown): ChangedFile | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const path = boundedString(raw.path);
  const oldPath = optionalString(raw.oldPath);
  const additions = finiteCount(raw.additions);
  const deletions = finiteCount(raw.deletions);
  const staged = optionalBoolean(raw.staged);
  const committed = optionalBoolean(raw.committed);
  const isNewFile = optionalBoolean(raw.isNewFile);
  const hash = optionalString(raw.hash);
  if (
    !path ||
    !VALID_STATUSES.has(raw.status as FileChangeStatus) ||
    additions === null ||
    deletions === null ||
    typeof raw.binary !== "boolean" ||
    oldPath === null ||
    staged === null ||
    committed === null ||
    isNewFile === null ||
    hash === null
  ) {
    return null;
  }
  return {
    path,
    ...(oldPath === undefined ? {} : { oldPath }),
    status: raw.status as FileChangeStatus,
    additions,
    deletions,
    // Diff bodies are deliberately never restored from this small list cache.
    patch: "",
    binary: raw.binary,
    ...(staged === undefined ? {} : { staged }),
    ...(committed === undefined ? {} : { committed }),
    ...(isNewFile === undefined ? {} : { isNewFile }),
    ...(hash === undefined ? {} : { hash }),
  };
}

/** Validate a complete list. Returning null (rather than truncating) prevents a
 * partial persisted result from looking authoritative. */
export function sanitizeChangesSections(
  value: unknown,
): CachedChangesSection[] | null {
  if (!Array.isArray(value) || value.length > MAX_SECTIONS_PER_KEY) return null;
  let fileCount = 0;
  const paths = new Set<string>();
  const sections: CachedChangesSection[] = [];
  for (const sectionValue of value) {
    if (
      !sectionValue ||
      typeof sectionValue !== "object" ||
      Array.isArray(sectionValue)
    ) {
      return null;
    }
    const raw = sectionValue as Record<string, unknown>;
    const title = raw.title === null ? null : boundedString(raw.title);
    if (
      (raw.kind !== "changes" && raw.kind !== "committed") ||
      (title === null && raw.title !== null) ||
      !Array.isArray(raw.files)
    ) {
      return null;
    }
    fileCount += raw.files.length;
    if (fileCount > MAX_FILES_PER_KEY) return null;
    const files: ChangedFile[] = [];
    for (const fileValue of raw.files) {
      const file = sanitizeFile(fileValue);
      if (!file || paths.has(file.path)) return null;
      paths.add(file.path);
      files.push(file);
    }
    sections.push({
      kind: raw.kind,
      title,
      files,
    });
  }
  return sections;
}

export function changesSnapshotKey(workspaceId: string, scope: Scope): string {
  return JSON.stringify([
    workspaceId,
    scope.kind,
    scope.kind === "commit" ? scope.sha : null,
  ]);
}

function readPayload(): StoredPayload {
  const value = getSetting<unknown>(STORAGE_KEY, null);
  const empty: StoredPayload = { version: 1, sections: [], counts: [] };
  if (!value || typeof value !== "object" || Array.isArray(value)) return empty;
  const raw = value as Record<string, unknown>;
  if (
    raw.version !== 1 ||
    !Array.isArray(raw.sections) ||
    !Array.isArray(raw.counts)
  ) {
    return empty;
  }

  const sectionByKey = new Map<string, StoredSectionEntry>();
  for (const valueEntry of raw.sections.slice(-MAX_SECTION_KEYS)) {
    if (
      !valueEntry ||
      typeof valueEntry !== "object" ||
      Array.isArray(valueEntry)
    )
      continue;
    const entry = valueEntry as Record<string, unknown>;
    const workspaceId = boundedString(entry.workspaceId);
    const scope = sanitizeScope(entry.scope);
    const savedAt = entry.savedAt;
    const sections = sanitizeChangesSections(entry.sections);
    if (
      !workspaceId ||
      !scope ||
      typeof savedAt !== "number" ||
      !Number.isFinite(savedAt) ||
      !sections ||
      sections.length === 0
    ) {
      continue;
    }
    const key = changesSnapshotKey(workspaceId, scope);
    sectionByKey.delete(key);
    sectionByKey.set(key, { workspaceId, scope, savedAt, sections });
  }

  const countByOwner = new Map<string, StoredCountEntry>();
  for (const valueEntry of raw.counts.slice(-MAX_COUNT_KEYS)) {
    if (
      !valueEntry ||
      typeof valueEntry !== "object" ||
      Array.isArray(valueEntry)
    )
      continue;
    const entry = valueEntry as Record<string, unknown>;
    const workspaceId = boundedString(entry.workspaceId);
    const savedAt = entry.savedAt;
    const count = finiteCount(entry.count);
    if (
      !workspaceId ||
      entry.basis !== "all" ||
      typeof savedAt !== "number" ||
      !Number.isFinite(savedAt) ||
      count === null
    )
      continue;
    countByOwner.delete(workspaceId);
    countByOwner.set(workspaceId, {
      workspaceId,
      savedAt,
      count,
      basis: "all",
    });
  }

  return {
    version: 1,
    sections: [...sectionByKey.values()].slice(-MAX_SECTION_KEYS),
    counts: [...countByOwner.values()].slice(-MAX_COUNT_KEYS),
  };
}

function writePayload(next: StoredPayload, protectedAt: number): boolean {
  const payload: StoredPayload = {
    version: 1,
    sections: next.sections.slice(-MAX_SECTION_KEYS),
    counts: next.counts.slice(-MAX_COUNT_KEYS),
  };
  while (JSON.stringify(payload).length > MAX_SERIALIZED_CHARS) {
    const candidates = [
      ...payload.sections.map((entry) => ({
        kind: "section" as const,
        savedAt: entry.savedAt,
      })),
      ...payload.counts.map((entry) => ({
        kind: "count" as const,
        savedAt: entry.savedAt,
      })),
    ].filter((entry) => entry.savedAt !== protectedAt);
    const oldest = candidates.sort((a, b) => a.savedAt - b.savedAt)[0];
    if (!oldest) return false;
    if (oldest.kind === "section") {
      const index = payload.sections.findIndex(
        (entry) => entry.savedAt === oldest.savedAt,
      );
      if (index >= 0) payload.sections.splice(index, 1);
    } else {
      const index = payload.counts.findIndex(
        (entry) => entry.savedAt === oldest.savedAt,
      );
      if (index >= 0) payload.counts.splice(index, 1);
    }
  }
  setSetting(STORAGE_KEY, payload);
  return true;
}

export function loadPersistedChangesSnapshots(): {
  sections: Map<string, CachedChangesSection[]>;
  counts: Map<string, number>;
} {
  const payload = readPayload();
  return {
    sections: new Map(
      payload.sections.map((entry) => [
        changesSnapshotKey(entry.workspaceId, entry.scope),
        entry.sections,
      ]),
    ),
    counts: new Map(
      payload.counts.map((entry) => [entry.workspaceId, entry.count]),
    ),
  };
}

export function persistChangesSections(
  workspaceId: string,
  scope: Scope,
  sections: CachedChangesSection[],
): void {
  if (!workspaceId) return;
  const confirmed = sanitizeChangesSections(sections);
  if (!confirmed) return;
  const payload = readPayload();
  const key = changesSnapshotKey(workspaceId, scope);
  payload.sections = payload.sections.filter(
    (entry) => changesSnapshotKey(entry.workspaceId, entry.scope) !== key,
  );
  // Never restore an old non-empty snapshot after Git confirmed this key empty.
  if (confirmed.length === 0) {
    if (payload.sections.length === 0 && payload.counts.length === 0) {
      removeSetting(STORAGE_KEY);
    } else {
      writePayload(payload, Number.NaN);
    }
    return;
  }
  const savedAt = nextSavedAt();
  payload.sections.push({ workspaceId, scope, savedAt, sections: confirmed });
  writePayload(payload, savedAt);
}

export function persistChangesCount(workspaceId: string, count: number): void {
  if (!workspaceId || finiteCount(count) === null) return;
  const payload = readPayload();
  const existing = payload.counts.find(
    (entry) => entry.workspaceId === workspaceId,
  );
  if (existing?.count === count) return;
  payload.counts = payload.counts.filter(
    (entry) => entry.workspaceId !== workspaceId,
  );
  const savedAt = nextSavedAt();
  payload.counts.push({ workspaceId, savedAt, count, basis: "all" });
  writePayload(payload, savedAt);
}

/** Prune both persisted and in-memory snapshots for removed semantic owners. */
export function forgetChangesSnapshots(workspaceIds: Iterable<string>): void {
  const owners = new Set([...workspaceIds].filter(Boolean));
  if (owners.size === 0) return;
  const payload = readPayload();
  payload.sections = payload.sections.filter(
    (entry) => !owners.has(entry.workspaceId),
  );
  payload.counts = payload.counts.filter(
    (entry) => !owners.has(entry.workspaceId),
  );
  for (const key of [...sectionCache.keys()]) {
    try {
      const [workspaceId] = JSON.parse(key) as [string];
      if (owners.has(workspaceId)) {
        sectionCache.delete(key);
        requestTokens.delete(key);
        for (const listener of sectionListeners.get(key) ?? []) listener();
      }
    } catch {
      sectionCache.delete(key);
      requestTokens.delete(key);
      for (const listener of sectionListeners.get(key) ?? []) listener();
    }
  }
  for (const owner of owners) countCache.delete(owner);
  if (payload.sections.length === 0 && payload.counts.length === 0) {
    removeSetting(STORAGE_KEY);
  } else {
    writePayload(payload, Number.NaN);
  }
}

const restored = loadPersistedChangesSnapshots();
const sectionCache = restored.sections;
const countCache = restored.counts;
const sectionListeners = new Map<string, Set<() => void>>();
const requestTokens = new Map<string, number>();
let nextRequestToken = 0;

function writeBounded<T>(
  cache: Map<string, T>,
  key: string,
  value: T,
  limit: number,
): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > limit) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function readChangesSections(
  key: string,
): CachedChangesSection[] | undefined {
  return sectionCache.get(key);
}

/** Exact-key subscriptions let retained Changes surfaces share one published
 * result instead of maintaining divergent component-local copies. */
export function subscribeChangesSections(
  key: string,
  listener: () => void,
): () => void {
  let listeners = sectionListeners.get(key);
  if (!listeners) {
    listeners = new Set();
    sectionListeners.set(key, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners?.delete(listener);
    if (listeners?.size === 0) sectionListeners.delete(key);
  };
}

export function hasChangesSections(key: string): boolean {
  return sectionCache.has(key);
}

export function writeChangesSections(
  workspaceId: string,
  scope: Scope,
  sections: CachedChangesSection[],
): void {
  const key = changesSnapshotKey(workspaceId, scope);
  if (sectionCache.get(key) === sections) return;
  writeBounded(sectionCache, key, sections, MAX_SECTION_KEYS);
  persistChangesSections(workspaceId, scope, sections);
  for (const listener of sectionListeners.get(key) ?? []) listener();
}

/** Claim the latest publication token for one exact scope. A response may
 * resolve for its caller, but only the newest token may update shared rows. */
export function beginChangesSectionsRequest(key: string): number {
  nextRequestToken += 1;
  requestTokens.set(key, nextRequestToken);
  while (requestTokens.size > MAX_SECTION_KEYS * 2) {
    const oldest = requestTokens.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    requestTokens.delete(oldest);
  }
  return nextRequestToken;
}

export function isCurrentChangesSectionsRequest(
  key: string,
  token: number,
): boolean {
  return requestTokens.get(key) === token;
}

export function readChangesCount(workspaceId: string): number | undefined {
  return countCache.get(workspaceId);
}

export function writeChangesCount(workspaceId: string, count: number): void {
  writeBounded(countCache, workspaceId, count, MAX_COUNT_KEYS);
  persistChangesCount(workspaceId, count);
}

export const changesSnapshotCacheLimits = Object.freeze({
  sectionKeys: MAX_SECTION_KEYS,
  countKeys: MAX_COUNT_KEYS,
  filesPerKey: MAX_FILES_PER_KEY,
  serializedChars: MAX_SERIALIZED_CHARS,
});
