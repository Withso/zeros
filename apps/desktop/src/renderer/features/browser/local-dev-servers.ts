// Workspace loopback dev servers for the Browser start page.
//
// One module-level store owns the native probe (`browser:list-local-servers`)
// and a bounded localStorage history, both keyed by the Local workspace folder
// (the workbench scope). Native lists only servers whose working directory is
// inside that folder and outside the registered workspaces nested in it, which
// are sent as `exclude`. Cloud and folderless scopes never probe.

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { z } from "zod";

import { nativeInvoke, useNativeRuntime } from "../../platform/runtime";
import { registeredLocalWorkspaceFolders } from "./local-workspace-folders";

export const LOCAL_DEV_SERVERS_STORAGE_KEY = "zeros:browser-dev-servers:v2";
export const LOCAL_DEV_SERVERS_HISTORY_LIMIT = 24;
/** Workspaces whose history is kept; the least recently probed go first. */
export const LOCAL_DEV_SERVERS_SCOPE_LIMIT = 32;
export const LOCAL_DEV_SERVERS_POLL_MS = 5_000;
/** Mirrors the native scope validation (electron/browser/local-dev-servers.ts). */
export const LOCAL_DEV_SERVERS_MAX_EXCLUDES = 256;
const MAX_FOLDER_LENGTH = 4_096;
/** Polls closer together than this reuse the last confirmed snapshot. */
const MIN_REFRESH_GAP_MS = 1_500;
/** lastSeenAt for an already-known online server is bumped at most this often,
 * which keeps history references stable and localStorage writes rare. */
const LAST_SEEN_RESOLUTION_MS = 60_000;

export interface LocalDevServer {
  port: number;
  url: string;
  title?: string;
  processName?: string;
  cwd?: string;
}

export interface LocalDevServerHistoryEntry extends LocalDevServer {
  lastSeenAt: number;
}

export type LocalDevServerFilter = "all" | "online";
export type LocalDevServerStatus = "online" | "offline" | "unknown";

export interface LocalDevServerRow extends LocalDevServerHistoryEntry {
  status: LocalDevServerStatus;
}

export interface LocalDevServersProbe {
  /** Canonical folder the native lister matched working directories against. */
  root: string;
  servers: LocalDevServer[];
  updatedAt: number;
}

export interface LocalDevServersState {
  /** Last confirmed probe; retained through revalidation and failures. */
  probe: LocalDevServersProbe | null;
  error: Error | null;
  history: LocalDevServerHistoryEntry[];
}

const EMPTY_STATE: LocalDevServersState = Object.freeze({
  probe: null,
  error: null,
  history: [] as LocalDevServerHistoryEntry[],
});

/** Lexical folder identity: trailing slashes and the macOS /private aliases
 * removed. Native canonicalizes again with realpath. */
export function normalizeLocalFolder(folder: string): string {
  const trimmed = folder.length > 1 ? folder.replace(/\/+$/, "") || "/" : folder;
  return trimmed.replace(/^\/private(\/(?:var|tmp|etc)(?:\/|$))/, "$1");
}

/** A Local workspace folder: absolute, bounded and never the filesystem root,
 * which would admit every process on the Mac. Cloud keys and the ambient
 * scope are not folders. */
export function isLocalWorkspaceFolder(scope: string | null | undefined): scope is string {
  if (typeof scope !== "string" || scope.length > MAX_FOLDER_LENGTH) return false;
  if (!scope.startsWith("/") || scope.includes("\0")) return false;
  return normalizeLocalFolder(scope) !== "/";
}

export function isPathInsideFolder(path: string | undefined, folder: string | null | undefined): boolean {
  if (!path || !folder || !folder.startsWith("/")) return false;
  const root = folder.length > 1 ? folder.replace(/\/+$/, "") : folder;
  return path === root || path.startsWith(root === "/" ? "/" : `${root}/`);
}

/** Registered folders strictly inside `root`. A folder inside another listed
 * folder adds nothing, so only the outermost ones are sent. */
export function nestedWorkspaceFolders(root: string, folders: Iterable<string>): string[] {
  const base = normalizeLocalFolder(root);
  const nested = new Set<string>();
  for (const candidate of folders) {
    if (!isLocalWorkspaceFolder(candidate)) continue;
    const folder = normalizeLocalFolder(candidate);
    if (folder !== base && isPathInsideFolder(folder, base)) nested.add(folder);
  }
  const outermost: string[] = [];
  for (const folder of [...nested].sort((a, b) => a.length - b.length || (a < b ? -1 : 1)))
    if (!outermost.some((outer) => isPathInsideFolder(folder, outer))) outermost.push(folder);
  return outermost.sort().slice(0, LOCAL_DEV_SERVERS_MAX_EXCLUDES);
}

const port = z.number().int().min(1).max(65_535);
const text = (max: number) => z.string().max(max).optional();

const ServerSchema = z
  .object({
    port,
    url: z.string().max(64),
    title: text(160),
    processName: text(64),
    cwd: text(1024),
  })
  .refine((value) => value.url === `http://localhost:${value.port}`, "Dev server URL must be its loopback port");

const ResponseSchema = z.object({
  root: z.string().min(2).max(MAX_FOLDER_LENGTH).startsWith("/"),
  servers: z.array(z.unknown()).max(256),
});

function compact(server: z.infer<typeof ServerSchema>): LocalDevServer {
  const out: LocalDevServer = { port: server.port, url: server.url };
  if (server.title) out.title = server.title;
  if (server.processName) out.processName = server.processName;
  if (server.cwd) out.cwd = server.cwd;
  return out;
}

/** Native boundary: drop any entry that is not a canonical localhost URL. */
export function parseLocalDevServersResponse(raw: unknown): { root: string; servers: LocalDevServer[] } {
  const parsed = ResponseSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Invalid local dev server response");
  const seen = new Set<number>();
  const servers: LocalDevServer[] = [];
  for (const item of parsed.data.servers) {
    const server = ServerSchema.safeParse(item);
    if (!server.success || seen.has(server.data.port)) continue;
    seen.add(server.data.port);
    servers.push(compact(server.data));
  }
  return { root: parsed.data.root, servers: servers.sort((a, b) => a.port - b.port) };
}

const HistoryEntrySchema = z.object({
  port,
  url: z.string().max(64),
  title: text(160),
  processName: text(64),
  cwd: text(1024),
  lastSeenAt: z.number().finite().nonnegative(),
});

export interface PersistedHistory {
  /** Most recently seen workspace first. */
  scopes: Array<[string, LocalDevServerHistoryEntry[]]>;
  filter: LocalDevServerFilter;
}

function readEntries(raw: unknown): LocalDevServerHistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  const byUrl = new Map<string, LocalDevServerHistoryEntry>();
  for (const item of raw.slice(0, LOCAL_DEV_SERVERS_HISTORY_LIMIT * 4)) {
    const entry = HistoryEntrySchema.safeParse(item);
    if (!entry.success) continue;
    if (entry.data.url !== `http://localhost:${entry.data.port}`) continue;
    const previous = byUrl.get(entry.data.url);
    if (previous && previous.lastSeenAt >= entry.data.lastSeenAt) continue;
    byUrl.set(entry.data.url, { ...compact(entry.data), lastSeenAt: entry.data.lastSeenAt });
  }
  return [...byUrl.values()]
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .slice(0, LOCAL_DEV_SERVERS_HISTORY_LIMIT);
}

/** Validate and bound persisted history; malformed scopes and entries are dropped. */
export function readPersistedHistory(raw: string | null): PersistedHistory {
  const empty: PersistedHistory = { scopes: [], filter: "all" };
  if (!raw || raw.length > 1024 * 1024) return empty;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (!value || typeof value !== "object") return empty;
  const record = value as { version?: unknown; scopes?: unknown; filter?: unknown };
  if (record.version !== 2 || !record.scopes || typeof record.scopes !== "object" || Array.isArray(record.scopes))
    return empty;
  const byFolder = new Map<string, LocalDevServerHistoryEntry[]>();
  for (const [scope, entries] of Object.entries(record.scopes).slice(0, LOCAL_DEV_SERVERS_SCOPE_LIMIT * 4)) {
    if (!isLocalWorkspaceFolder(scope)) continue;
    const folder = normalizeLocalFolder(scope);
    const rows = readEntries(entries);
    if (rows.length > 0 && !byFolder.has(folder)) byFolder.set(folder, rows);
  }
  return {
    scopes: [...byFolder.entries()]
      .sort(([, a], [, b]) => b[0].lastSeenAt - a[0].lastSeenAt)
      .slice(0, LOCAL_DEV_SERVERS_SCOPE_LIMIT),
    filter: record.filter === "online" ? "online" : "all",
  };
}

export function serializeHistory(
  scopes: Iterable<[string, readonly LocalDevServerHistoryEntry[]]>,
  filter: LocalDevServerFilter,
): string {
  const out: Record<string, readonly LocalDevServerHistoryEntry[]> = {};
  for (const [scope, entries] of scopes) if (entries.length > 0) out[scope] = entries;
  return JSON.stringify({ version: 2, scopes: out, filter });
}

function sameMetadata(entry: LocalDevServer, server: LocalDevServer): boolean {
  return (
    entry.title === server.title &&
    entry.processName === server.processName &&
    entry.cwd === server.cwd
  );
}

function sameServers(a: readonly LocalDevServer[], b: readonly LocalDevServer[]): boolean {
  return (
    a.length === b.length &&
    a.every((server, index) => server.url === b[index].url && sameMetadata(server, b[index]))
  );
}

/** Fold an online probe into history. Returns the same array when nothing
 * meaningful changed so subscribers and storage stay quiet. */
export function mergeHistory(
  history: readonly LocalDevServerHistoryEntry[],
  servers: readonly LocalDevServer[],
  now: number,
): LocalDevServerHistoryEntry[] {
  if (servers.length === 0) return history as LocalDevServerHistoryEntry[];
  const byUrl = new Map(history.map((entry) => [entry.url, entry]));
  let changed = false;
  for (const server of servers) {
    const previous = byUrl.get(server.url);
    if (
      previous &&
      sameMetadata(previous, server) &&
      now - previous.lastSeenAt < LAST_SEEN_RESOLUTION_MS
    )
      continue;
    changed = true;
    byUrl.set(server.url, { ...server, lastSeenAt: now });
  }
  if (!changed) return history as LocalDevServerHistoryEntry[];
  const online = new Set(servers.map((server) => server.url));
  // Online servers are never evicted by the cap; offline ones go oldest-first.
  return [...byUrl.values()]
    .sort((a, b) => {
      const live = Number(online.has(b.url)) - Number(online.has(a.url));
      return live || b.lastSeenAt - a.lastSeenAt;
    })
    .slice(0, LOCAL_DEV_SERVERS_HISTORY_LIMIT);
}

/** "Clear history" removes only servers that are not currently online. */
export function clearOfflineHistory(
  history: readonly LocalDevServerHistoryEntry[],
  servers: readonly LocalDevServer[] | null,
): LocalDevServerHistoryEntry[] {
  const online = new Set((servers ?? []).map((server) => server.url));
  const next = history.filter((entry) => online.has(entry.url));
  return next.length === history.length ? (history as LocalDevServerHistoryEntry[]) : next;
}

export function buildLocalDevServerRows(input: {
  history: readonly LocalDevServerHistoryEntry[];
  probe: LocalDevServersProbe | null;
  filter: LocalDevServerFilter;
}): LocalDevServerRow[] {
  const rows = new Map<string, LocalDevServerRow>();
  const known = input.probe !== null;
  for (const entry of input.history)
    rows.set(entry.url, { ...entry, status: known ? "offline" : "unknown" });
  for (const server of input.probe?.servers ?? []) {
    const previous = rows.get(server.url);
    rows.set(server.url, {
      ...server,
      lastSeenAt: input.probe!.updatedAt,
      status: "online",
      cwd: server.cwd ?? previous?.cwd,
      title: server.title ?? previous?.title,
      processName: server.processName ?? previous?.processName,
    });
  }
  const rank = (row: LocalDevServerRow) => (row.status === "online" ? 0 : 1);
  return [...rows.values()]
    .filter((row) => input.filter === "all" || row.status === "online")
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (a.status === "online" ? a.port - b.port : b.lastSeenAt - a.lastSeenAt),
    );
}

export interface LocalDevServerScopeRequest {
  root: string;
  exclude: string[];
}

export interface LocalDevServerStoreOptions {
  invoke: (request: LocalDevServerScopeRequest) => Promise<unknown>;
  /** Registered Local workspace folders, read when each probe starts. */
  workspaceFolders?: () => Iterable<string>;
  storage: () => Pick<Storage, "getItem" | "setItem"> | null;
  now?: () => number;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export class LocalDevServerStore {
  /** Insertion order is recency: the least recently probed workspace is first. */
  private readonly scopes = new Map<string, LocalDevServersState>();
  private readonly checkedAt = new Map<string, number>();
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly listeners = new Set<() => void>();
  private filter: LocalDevServerFilter = "all";
  private readonly now: () => number;

  public constructor(private readonly options: LocalDevServerStoreOptions) {
    this.now = options.now ?? Date.now;
    let persisted: PersistedHistory = { scopes: [], filter: "all" };
    try {
      persisted = readPersistedHistory(options.storage()?.getItem(LOCAL_DEV_SERVERS_STORAGE_KEY) ?? null);
    } catch {
      /* storage unavailable: start empty */
    }
    for (const [scope, history] of [...persisted.scopes].reverse())
      this.scopes.set(scope, { probe: null, error: null, history });
    this.filter = persisted.filter;
  }

  /** Stable per workspace until that workspace's servers or history change. */
  public getState = (scope: string): LocalDevServersState =>
    isLocalWorkspaceFolder(scope)
      ? (this.scopes.get(normalizeLocalFolder(scope)) ?? EMPTY_STATE)
      : EMPTY_STATE;

  public getFilter = (): LocalDevServerFilter => this.filter;

  public subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Shares one in-flight probe per workspace across every mounted consumer. */
  public refresh = (scope: string, options: { force?: boolean } = {}): Promise<void> => {
    if (!isLocalWorkspaceFolder(scope)) return Promise.resolve();
    const root = normalizeLocalFolder(scope);
    const running = this.inflight.get(root);
    if (running) return running;
    if (!options.force && this.now() - (this.checkedAt.get(root) ?? 0) < MIN_REFRESH_GAP_MS)
      return Promise.resolve();
    let pending: Promise<unknown>;
    try {
      let folders: Iterable<string> = [];
      try {
        folders = this.options.workspaceFolders?.() ?? [];
      } catch {
        /* registry unavailable: no nested exclusions */
      }
      pending = this.options.invoke({ root, exclude: nestedWorkspaceFolders(root, folders) });
    } catch (error) {
      pending = Promise.reject(error);
    }
    const request = pending
      .then((raw) => {
        const result = parseLocalDevServersResponse(raw);
        const updatedAt = this.now();
        this.checkedAt.set(root, updatedAt);
        const current = this.scopes.get(root) ?? EMPTY_STATE;
        const history = mergeHistory(current.history, result.servers, updatedAt);
        const probe =
          current.probe &&
          current.probe.root === result.root &&
          sameServers(current.probe.servers, result.servers)
            ? current.probe
            : { root: result.root, servers: result.servers, updatedAt };
        this.update(root, { probe, error: null, history });
      })
      .catch((error: unknown) => {
        this.checkedAt.set(root, this.now());
        const next = toError(error);
        const previous = this.scopes.get(root)?.error ?? null;
        this.update(root, { error: previous && previous.message === next.message ? previous : next });
      })
      .finally(() => {
        this.inflight.delete(root);
      });
    this.inflight.set(root, request);
    return request;
  };

  public clearHistory = (scope: string): void => {
    if (!isLocalWorkspaceFolder(scope)) return;
    const root = normalizeLocalFolder(scope);
    const current = this.scopes.get(root);
    if (!current) return;
    this.update(root, { history: clearOfflineHistory(current.history, current.probe?.servers ?? null) });
  };

  public setFilter = (filter: LocalDevServerFilter): void => {
    if (filter === this.filter) return;
    this.filter = filter;
    this.persist();
    this.emit();
  };

  private update(root: string, patch: Partial<LocalDevServersState>): void {
    const previous = this.scopes.get(root) ?? EMPTY_STATE;
    const changed = (Object.keys(patch) as Array<keyof LocalDevServersState>).some(
      (key) => patch[key] !== previous[key],
    );
    this.scopes.delete(root);
    this.scopes.set(root, changed ? { ...previous, ...patch } : previous);
    const evicted = this.evict(root);
    if (!changed && !evicted) return;
    if (evicted || (patch.history !== undefined && patch.history !== previous.history)) this.persist();
    this.emit();
  }

  private evict(keep: string): boolean {
    let evicted = false;
    for (const scope of this.scopes.keys()) {
      if (this.scopes.size <= LOCAL_DEV_SERVERS_SCOPE_LIMIT) break;
      if (scope === keep || this.inflight.has(scope)) continue;
      this.scopes.delete(scope);
      this.checkedAt.delete(scope);
      evicted = true;
    }
    return evicted;
  }

  private persist(): void {
    try {
      this.options
        .storage()
        ?.setItem(
          LOCAL_DEV_SERVERS_STORAGE_KEY,
          serializeHistory(
            [...this.scopes].map(([scope, state]) => [scope, state.history] as [string, LocalDevServerHistoryEntry[]]),
            this.filter,
          ),
        );
    } catch {
      /* quota or private mode: history stays in memory */
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

function browserStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export const localDevServers = new LocalDevServerStore({
  invoke: (request) => nativeInvoke("browser:list-local-servers", { ...request }),
  workspaceFolders: registeredLocalWorkspaceFolders,
  storage: browserStorage,
});

/** Local workspace folders only, and only for the visible active surface. */
export function localDevServersPollingEnabled(input: {
  scope: string;
  active: boolean;
  nativeReady: boolean;
  documentVisible: boolean;
}): boolean {
  return input.active && input.nativeReady && input.documentVisible && isLocalWorkspaceFolder(input.scope);
}

function documentVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

export function useLocalDevServers(
  input: { scope: string; active: boolean },
  store: LocalDevServerStore = localDevServers,
) {
  const nativeReady = useNativeRuntime().ready;
  const [visible, setVisible] = useState(documentVisible);
  const { scope, active } = input;
  const available = isLocalWorkspaceFolder(scope);
  useEffect(() => {
    if (!active || !available || typeof document === "undefined") return;
    const change = () => setVisible(documentVisible());
    change();
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, [active, available]);
  const enabled = localDevServersPollingEnabled({ scope, active, nativeReady, documentVisible: visible });
  useEffect(() => {
    if (!enabled) return;
    const refresh = () => void store.refresh(scope);
    refresh();
    const timer = setInterval(() => {
      if (documentVisible()) refresh();
    }, LOCAL_DEV_SERVERS_POLL_MS);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [enabled, store, scope]);
  const getState = useCallback(() => store.getState(scope), [store, scope]);
  const state = useSyncExternalStore(store.subscribe, getState, getState);
  const filter = useSyncExternalStore(store.subscribe, store.getFilter, store.getFilter);
  const rows = useMemo(
    () => buildLocalDevServerRows({ history: state.history, probe: state.probe, filter }),
    [state.history, state.probe, filter],
  );
  const hasOffline = useMemo(() => {
    const online = new Set((state.probe?.servers ?? []).map((server) => server.url));
    return state.history.some((entry) => !online.has(entry.url));
  }, [state.history, state.probe]);
  const clearHistory = useCallback(() => store.clearHistory(scope), [store, scope]);
  const setFilter = useCallback((next: LocalDevServerFilter) => store.setFilter(next), [store]);
  return { available, state, filter, rows, hasOffline, clearHistory, setFilter };
}
