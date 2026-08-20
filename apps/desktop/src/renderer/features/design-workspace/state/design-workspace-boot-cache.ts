// Synchronous boot preview for the Design aggregate snapshot.
//
// The engine remains authoritative. This device-local mirror exists only so a
// restored Design workspace can paint its last confirmed frame geometry,
// layers, tokens, and review rows before the first bridge round trip settles.
// Every hydrated entry is marked stale by the owner cache and revalidated.

import type { DesignWorkspaceSnapshotWire } from "../../../platform/git";
import { getSetting, setSetting } from "../../../platform/settings";

const STORAGE_KEY = "design-workspace-snapshots-v1";
const MAX_STORED_WORKSPACES = 4;
const MAX_STORED_ENTRY_CHARS = 750_000;
const MAX_STORED_TOTAL_CHARS = 2_000_000;
const MAX_FRAMES = 256;
const MAX_TOKENS = 4_096;
const MAX_THEME_VALUES = 64;
const MAX_ASSETS = 128;
const MAX_VIOLATIONS = 8_192;

interface StoredDesignSnapshot {
  updatedAt: number;
  snapshot: DesignWorkspaceSnapshotWire;
}

interface StoredDesignSnapshots {
  version: 1;
  entries: Record<string, StoredDesignSnapshot>;
}

const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SOURCE_VERSION_PATTERN = /^[a-f0-9]{24}$/;

function boundedString(
  value: unknown,
  maxLength = 8_192,
): string | null {
  return typeof value === "string" && value.length <= maxLength ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function optionalString(
  value: unknown,
  maxLength = 8_192,
): string | undefined | null {
  if (value === undefined) return undefined;
  return boundedString(value, maxLength);
}

/** Strip process authority and large embedded image bytes while validating the
 * complete semantic snapshot. Returning null (rather than a partial surface)
 * keeps corrupt or oversized localStorage from becoming UI state. */
export function safeDesignWorkspaceBootSnapshot(
  value: unknown,
): DesignWorkspaceSnapshotWire | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<DesignWorkspaceSnapshotWire>;
  if (
    !Array.isArray(candidate.frames) ||
    candidate.frames.length > MAX_FRAMES ||
    !Array.isArray(candidate.tokens) ||
    candidate.tokens.length > MAX_TOKENS ||
    !Array.isArray(candidate.assets) ||
    candidate.assets.length > MAX_ASSETS ||
    !candidate.lint ||
    typeof candidate.lint !== "object" ||
    !Array.isArray(candidate.lint.checkedFiles) ||
    candidate.lint.checkedFiles.length > MAX_FRAMES ||
    !Array.isArray(candidate.lint.violations) ||
    candidate.lint.violations.length > MAX_VIOLATIONS
  ) {
    return null;
  }

  const frames: DesignWorkspaceSnapshotWire["frames"] = [];
  for (const frame of candidate.frames) {
    const file = boundedString(frame?.file, 2_048);
    const title = boundedString(frame?.title, 512);
    const sourceVersion = boundedString(frame?.sourceVersion, 24);
    const width = finiteNumber(frame?.width);
    const height = finiteNumber(frame?.height);
    const x = finiteNumber(frame?.x);
    const y = finiteNumber(frame?.y);
    const z = finiteNumber(frame?.z);
    const nodeCount = finiteNumber(frame?.nodeCount);
    const modifiedAt = finiteNumber(frame?.modifiedAt);
    if (
      !file ||
      !title ||
      !sourceVersion ||
      !SOURCE_VERSION_PATTERN.test(sourceVersion) ||
      width === null ||
      height === null ||
      x === null ||
      y === null ||
      z === null ||
      nodeCount === null ||
      modifiedAt === null ||
      width < 1 ||
      width > 16_384 ||
      height < 1 ||
      height > 16_384 ||
      x < -1_000_000 ||
      x > 1_000_000 ||
      y < -1_000_000 ||
      y > 1_000_000 ||
      !Number.isInteger(z) ||
      z < 0 ||
      z > MAX_FRAMES ||
      !Number.isSafeInteger(nodeCount) ||
      nodeCount < 0 ||
      modifiedAt < 0 ||
      (frame.kind !== undefined &&
        frame.kind !== "frame" &&
        frame.kind !== "text")
    ) {
      return null;
    }
    frames.push({
      file,
      title,
      ...(frame.kind ? { kind: frame.kind } : {}),
      width,
      height,
      x,
      y,
      z,
      nodeCount,
      modifiedAt,
      sourceVersion,
    });
  }

  const tokens: DesignWorkspaceSnapshotWire["tokens"] = [];
  for (const token of candidate.tokens) {
    const name = boundedString(token?.name, 256);
    const syntax = boundedString(token?.syntax, 2_048);
    const initialValue = boundedString(token?.initialValue, 8_192);
    const tokenValue = boundedString(token?.value, 8_192);
    const usageCount = finiteNumber(token?.usageCount);
    const line = finiteNumber(token?.line);
    if (
      !name ||
      syntax === null ||
      initialValue === null ||
      tokenValue === null ||
      typeof token?.inherits !== "boolean" ||
      usageCount === null ||
      line === null ||
      !token.themeValues ||
      typeof token.themeValues !== "object" ||
      Array.isArray(token.themeValues)
    ) {
      return null;
    }
    const themeEntries = Object.entries(token.themeValues);
    if (themeEntries.length > MAX_THEME_VALUES) return null;
    const themeValues: Record<string, string> = {};
    for (const [theme, themeValue] of themeEntries) {
      const safeTheme = boundedString(theme, 128);
      const safeValue = boundedString(themeValue, 8_192);
      if (!safeTheme || safeValue === null) return null;
      themeValues[safeTheme] = safeValue;
    }
    tokens.push({
      name,
      syntax,
      inherits: token.inherits,
      initialValue,
      value: tokenValue,
      themeValues,
      usageCount,
      line,
    });
  }

  const assets: DesignWorkspaceSnapshotWire["assets"] = [];
  for (const asset of candidate.assets) {
    const assetPath = boundedString(asset?.path, 4_096);
    const name = boundedString(asset?.name, 1_024);
    const mimeType = boundedString(asset?.mimeType, 256);
    const size = finiteNumber(asset?.size);
    const modifiedAt = finiteNumber(asset?.modifiedAt);
    if (
      !assetPath ||
      !name ||
      !mimeType ||
      size === null ||
      modifiedAt === null
    ) {
      return null;
    }
    assets.push({
      path: assetPath,
      name,
      mimeType,
      size,
      modifiedAt,
      dataUrl: null,
    });
  }

  const workspacePath = boundedString(candidate.lint.workspacePath, 8_192);
  const checkedFiles = candidate.lint.checkedFiles.map((file) =>
    boundedString(file, 2_048),
  );
  const healedOids = finiteNumber(candidate.lint.healedOids);
  if (
    !workspacePath ||
    checkedFiles.some((file) => file === null) ||
    healedOids === null
  ) {
    return null;
  }
  const violations: DesignWorkspaceSnapshotWire["lint"]["violations"] = [];
  for (const violation of candidate.lint.violations) {
    const ruleId = boundedString(violation?.ruleId, 256);
    const message = boundedString(violation?.message, 8_192);
    const file = boundedString(violation?.file, 2_048);
    const line = finiteNumber(violation?.line);
    const column = finiteNumber(violation?.column);
    const oid = optionalString(violation?.oid, 512);
    const fix = optionalString(violation?.fix, 8_192);
    if (
      !ruleId ||
      !message ||
      !file ||
      (violation.severity !== "error" && violation.severity !== "warning") ||
      line === null ||
      column === null ||
      oid === null ||
      fix === null
    ) {
      return null;
    }
    violations.push({
      ruleId,
      severity: violation.severity,
      message,
      file,
      line,
      column,
      ...(oid !== undefined ? { oid } : {}),
      ...(fix !== undefined ? { fix } : {}),
    });
  }

  const tokenSourceVersion = boundedString(
    candidate.tokenSourceVersion,
    256,
  );
  if (!tokenSourceVersion) return null;
  return {
    // Capabilities derive from an engine-process secret and must never survive
    // that process or cross launches.
    protocolCapability: null,
    frames,
    tokens,
    tokenSourceVersion,
    assets,
    lint: {
      workspacePath,
      checkedFiles: checkedFiles as string[],
      violations,
      healedOids,
    },
  };
}

function normalizedWorkspacePath(value: string): string {
  return value
    .replace(/^\/private(\/(?:var|tmp|etc)\/)/, "$1")
    .replace(/\/+$/, "");
}

/** Workspace ids are normally unique, but restore can keep an id while
 * adapting its checkout path. Never paint the old path's preview into that new
 * semantic owner; the shared key can still revalidate and replace it. */
export function designWorkspaceSnapshotMatchesPath(
  snapshot: DesignWorkspaceSnapshotWire | undefined,
  workspacePath: string | null | undefined,
): boolean {
  if (!snapshot || !workspacePath) return true;
  return (
    normalizedWorkspacePath(snapshot.lint.workspacePath) ===
    normalizedWorkspacePath(workspacePath)
  );
}

let storedEntries: Record<string, StoredDesignSnapshot> | null = null;
let lastStoredAt = 0;

function loadStoredEntries(): Record<string, StoredDesignSnapshot> {
  if (storedEntries) return storedEntries;
  const stored = getSetting<unknown>(STORAGE_KEY, null);
  const candidate =
    stored && typeof stored === "object"
      ? (stored as Partial<StoredDesignSnapshots>)
      : null;
  const entries: Record<string, StoredDesignSnapshot> = {};
  if (
    candidate?.version === 1 &&
    candidate.entries &&
    typeof candidate.entries === "object" &&
    !Array.isArray(candidate.entries)
  ) {
    for (const [workspaceId, value] of Object.entries(candidate.entries)) {
      if (!WORKSPACE_ID_PATTERN.test(workspaceId)) continue;
      if (!value || typeof value !== "object") continue;
      const entry = value as Partial<StoredDesignSnapshot>;
      const snapshot = safeDesignWorkspaceBootSnapshot(entry.snapshot);
      if (
        !snapshot ||
        JSON.stringify(snapshot).length > MAX_STORED_ENTRY_CHARS ||
        typeof entry.updatedAt !== "number" ||
        !Number.isSafeInteger(entry.updatedAt) ||
        entry.updatedAt <= 0
      ) {
        continue;
      }
      entries[workspaceId] = { updatedAt: entry.updatedAt, snapshot };
    }
  }
  pruneEntries(entries);
  storedEntries = entries;
  for (const entry of Object.values(entries)) {
    lastStoredAt = Math.max(lastStoredAt, entry.updatedAt);
  }
  return entries;
}

function pruneEntries(entries: Record<string, StoredDesignSnapshot>): void {
  const newest = Object.entries(entries).sort(
    (left, right) => right[1].updatedAt - left[1].updatedAt,
  );
  for (const [workspaceId] of newest.slice(MAX_STORED_WORKSPACES)) {
    delete entries[workspaceId];
  }
  let payload: StoredDesignSnapshots = { version: 1, entries };
  while (
    Object.keys(entries).length > 0 &&
    JSON.stringify(payload).length > MAX_STORED_TOTAL_CHARS
  ) {
    const oldest = Object.entries(entries).sort(
      (left, right) => left[1].updatedAt - right[1].updatedAt,
    )[0]?.[0];
    if (!oldest) break;
    delete entries[oldest];
    payload = { version: 1, entries };
  }
}

function pruneAndPersist(entries: Record<string, StoredDesignSnapshot>): void {
  pruneEntries(entries);
  const payload: StoredDesignSnapshots = { version: 1, entries };
  setSetting(STORAGE_KEY, payload);
}

const pendingSnapshots = new Map<string, DesignWorkspaceSnapshotWire>();
type PendingFlush =
  | { scheduler: "idle"; handle: number }
  | { scheduler: "timeout"; handle: number };
let pendingFlush: PendingFlush | null = null;

function cancelPendingFlush(): void {
  if (pendingFlush === null || typeof window === "undefined") return;
  if (pendingFlush.scheduler === "idle") {
    const idleWindow = window as Window & {
      cancelIdleCallback?: (handle: number) => void;
    };
    idleWindow.cancelIdleCallback?.(pendingFlush.handle);
  } else {
    window.clearTimeout(pendingFlush.handle);
  }
}

function flushPendingSnapshots(): void {
  cancelPendingFlush();
  pendingFlush = null;
  if (pendingSnapshots.size === 0) return;
  const entries = loadStoredEntries();
  for (const [workspaceId, value] of pendingSnapshots) {
    pendingSnapshots.delete(workspaceId);
    if (!WORKSPACE_ID_PATTERN.test(workspaceId)) continue;
    const snapshot = safeDesignWorkspaceBootSnapshot(value);
    if (!snapshot) continue;
    if (JSON.stringify(snapshot).length > MAX_STORED_ENTRY_CHARS) {
      delete entries[workspaceId];
      continue;
    }
    // Date.now() can be identical for a burst of mutation receipts. Preserve
    // true MRU order with a monotonic local tick so pruning never discards the
    // newest workspace merely because several writes shared one millisecond.
    lastStoredAt = Math.max(Date.now(), lastStoredAt + 1);
    entries[workspaceId] = { updatedAt: lastStoredAt, snapshot };
  }
  pruneAndPersist(entries);
}

/** Defer serialization off the engine-response paint path. Pagehide flushes
 * the latest pending value so a rapid reload still restores it. */
export function queueDesignWorkspaceBootSnapshot(
  workspaceId: string,
  snapshot: DesignWorkspaceSnapshotWire,
): void {
  pendingSnapshots.delete(workspaceId);
  pendingSnapshots.set(workspaceId, snapshot);
  if (typeof window === "undefined") {
    flushPendingSnapshots();
    return;
  }
  if (pendingFlush !== null) return;
  const idleWindow = window as Window & {
    requestIdleCallback?: (
      callback: () => void,
      options?: { timeout: number },
    ) => number;
  };
  pendingFlush = idleWindow.requestIdleCallback
    ? {
        scheduler: "idle",
        handle: idleWindow.requestIdleCallback(flushPendingSnapshots, {
          timeout: 1_000,
        }),
      }
    : {
        scheduler: "timeout",
        handle: window.setTimeout(flushPendingSnapshots, 100),
      };
}

export function readDesignWorkspaceBootSnapshots(): ReadonlyMap<
  string,
  DesignWorkspaceSnapshotWire
> {
  return new Map(
    Object.entries(loadStoredEntries())
      .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
      .map(([workspaceId, entry]) => [workspaceId, entry.snapshot]),
  );
}

export function forgetDesignWorkspaceBootSnapshot(workspaceId: string): void {
  pendingSnapshots.delete(workspaceId);
  const entries = loadStoredEntries();
  if (!(workspaceId in entries)) return;
  delete entries[workspaceId];
  pruneAndPersist(entries);
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushPendingSnapshots);
}

/** Reset module memory without deleting the durable value; reload tests use
 * this to simulate a new renderer realm against the same localStorage. */
export function resetDesignWorkspaceBootCacheForTests(): void {
  cancelPendingFlush();
  pendingSnapshots.clear();
  pendingFlush = null;
  storedEntries = null;
  lastStoredAt = 0;
}
