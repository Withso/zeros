import { isAttachmentSourceId, validateAttachmentFile } from "@zeros/protocol/attachment-policy";
import { useCallback, useSyncExternalStore } from "react";
import { registerAttachmentSourceOwner } from "../features/agent/attachment-source-retention";
import type { ComposerAttachment } from "../features/agent/composer-attachments";
import { composerDraftHasPayload } from "./composer-draft-payload";
import type { ComposerDraft } from "./store";

export const CREATE_DRAFT_STORAGE_KEY = "zeros:create-composer-drafts:v1";
export const MAX_CREATE_DRAFTS = 128;
const MAX_DRAFT_BYTES = 1_000_000;
const MAX_STORE_BYTES = 4_000_000;
const MAX_DRAFT_ATTACHMENTS = 1000;
const MAX_DRAFT_DIRECTORIES = 128;
type DraftStorage = Pick<Storage, "getItem" | "setItem">;
export interface CreateDraftScope {
  /** Device Local, or the exact backend/account/organization identity. */
  owner: string;
  placement: "local" | "cloud";
  /** Normalized Local root, installed cloud repository id, or not yet chosen. */
  project: string | null;
}
export interface CreateDraftRecord {
  revision: number;
  draft: CreateComposerDraft;
}
export interface CreateComposerDraft extends ComposerDraft {
  /** Local directory references belong to the same unsent document as pills. */
  additionalDirectories?: string[];
}

function hasPayload(draft: CreateComposerDraft | undefined): boolean {
  return composerDraftHasPayload(draft) || Boolean(draft?.additionalDirectories?.length);
}

function validDirectories(value: unknown): value is string[] | undefined {
  return value === undefined || Array.isArray(value) && value.length <= MAX_DRAFT_DIRECTORIES &&
    value.every(path => typeof path === "string" && path.length > 0 && path.length <= 8192 && !path.includes("\0"));
}
/** Share the persisted identity with passive surfaces without a runtime read. */
export function createComposerDraftOwner({ backend, userId, organizationId }: {
  backend: string | null;
  userId: string | null | undefined;
  organizationId: string | null;
}): string | null {
  if (organizationId === null) return "local";
  return userId ? JSON.stringify([backend, userId, organizationId]) : null;
}
export function createComposerDraftKey(scope: CreateDraftScope): string {
  return JSON.stringify([scope.owner, scope.placement, scope.project]);
}
export function parseCreateComposerDraftKey(key: string): CreateDraftScope | null {
  try {
    const value: unknown = JSON.parse(key);
    if (!Array.isArray(value) || value.length !== 3 ||
      typeof value[0] !== "string" || !value[0] || value[0].length > 2048 ||
      !["local", "cloud"].includes(value[1]) ||
      (value[2] !== null && (typeof value[2] !== "string" || !value[2] || value[2].length > 8192))) return null;
    return { owner: value[0], placement: value[1], project: value[2] };
  } catch { return null; }
}
export function pendingCreateComposerDraftKey(key: string): string | null {
  const scope = parseCreateComposerDraftKey(key);
  return scope?.project ? createComposerDraftKey({ ...scope, project: null }) : null;
}

/** Only file identity enters synchronous draft storage. The recovery store
 * owns bytes; a document with missing metadata keeps an unavailable pill. */
function attachmentMetadata(a: ComposerAttachment): ComposerAttachment {
  return {
    id: a.id, name: a.name, mimeType: a.mimeType, size: a.size, kind: a.kind,
    data: "", delivery: "reference", validation: validateAttachmentFile(a),
    ...(a.sourceRecoveryId ? { sourceRecoveryId: a.sourceRecoveryId } : {}),
    ...(a.sourcePortable ? { sourcePortable: true } : {}),
    ...(a.diskPath ? { diskPath: a.diskPath } : {}),
    ...(a.contextAttachmentId ? { contextAttachmentId: a.contextAttachmentId } : {}),
    ...(a.owner ? { owner: a.owner } : {}),
    ...(a.absolutePath ? { absolutePath: a.absolutePath } : {}),
    ...(a.unavailable ? { unavailable: true } : {}),
    ...(a.sourceKey ? { sourceKey: a.sourceKey } : {}),
    ...(a.preview ? { preview: a.preview } : {}),
  };
}
function validDraft(value: unknown): value is CreateComposerDraft {
  if (!value || typeof value !== "object") return false;
  const d = value as Partial<CreateComposerDraft>;
  return typeof d.text === "string" && validDirectories(d.additionalDirectories) &&
    (d.json == null || typeof d.json === "object" && !Array.isArray(d.json)) &&
    Array.isArray(d.attachments) && d.attachments.length <= MAX_DRAFT_ATTACHMENTS && d.attachments.every(a =>
      a && typeof a.id === "string" && typeof a.name === "string" &&
      typeof a.mimeType === "string" && Number.isSafeInteger(a.size) && a.size >= 0 &&
      ["file", "image", "text"].includes(a.kind) &&
      (a.sourceRecoveryId === undefined || isAttachmentSourceId(a.sourceRecoveryId)));
}

function draftJson(draft: CreateComposerDraft): string {
  return JSON.stringify({ text: draft.text, json: draft.json ?? null, attachments: draft.attachments.map(attachmentMetadata),
    ...(draft.additionalDirectories?.length ? { additionalDirectories: draft.additionalDirectories } : {}) });
}

/** Bounded metadata only. An exhausted quota never evicts another unsent draft
 * or drops attachments to make the current write look successful. */
export class CreateComposerDraftStore {
  private records = new Map<string, { record: CreateDraftRecord; json: string }>();
  private selections = new Map<string, CreateDraftScope>();
  private revision = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private dirty = false;
  private listeners = new Set<(key: string) => void>();
  private errorListeners = new Set<() => void>();
  private ownerCounts = new Map<string, number>();
  private presenceListeners = new Map<string, Set<() => void>>();
  constructor(private readonly storage: DraftStorage | undefined) {
    try {
      const raw = storage?.getItem(CREATE_DRAFT_STORAGE_KEY);
      if (!raw || raw.length > MAX_STORE_BYTES) return;
      const parsed = JSON.parse(raw) as { version?: unknown; entries?: unknown; selections?: unknown } | null;
      if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) return;
      for (const row of parsed.entries.slice(0, MAX_CREATE_DRAFTS)) {
        if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== "string" || !parseCreateComposerDraftKey(row[0])) continue;
        const record = row[1] as CreateDraftRecord | null;
        if (!record || !Number.isSafeInteger(record.revision) || record.revision < 1 || !validDraft(record.draft)) continue;
        const json = draftJson(record.draft);
        if (json.length > MAX_DRAFT_BYTES) continue;
        this.records.set(row[0], { record: { revision: record.revision, draft: JSON.parse(json) }, json });
        this.revision = Math.max(this.revision, record.revision);
      }
      if (Array.isArray(parsed.selections)) for (const key of parsed.selections.slice(-MAX_CREATE_DRAFTS)) {
        const scope = typeof key === "string" ? parseCreateComposerDraftKey(key) : null;
        if (scope?.project) this.selections.set(JSON.stringify([scope.owner, scope.placement]), scope);
      }
    } catch { /* Unreadable browser storage must not prevent Create opening. */ }
    for (const [key, { record }] of this.records) {
      if (hasPayload(record.draft)) this.changePresence(parseCreateComposerDraftKey(key)!.owner, 1);
    }
  }
  get(key: string): CreateDraftRecord | undefined { return this.records.get(key)?.record; }
  drafts(): CreateComposerDraft[] { return [...this.records.values()].map(value => value.record.draft); }
  hasDraft(owner: string | null): boolean { return owner !== null && (this.ownerCounts.get(owner) ?? 0) > 0; }
  /** Publish only empty/nonempty transitions, not every composer keystroke. */
  subscribePresence(owner: string | null, listener: () => void): () => void {
    if (owner === null) return () => {};
    let listeners = this.presenceListeners.get(owner);
    if (!listeners) this.presenceListeners.set(owner, listeners = new Set());
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.presenceListeners.delete(owner);
    };
  }
  private changePresence(owner: string, delta: 1 | -1): void {
    const previous = this.ownerCounts.get(owner) ?? 0;
    const next = previous + delta;
    if (next > 0) this.ownerCounts.set(owner, next);
    else this.ownerCounts.delete(owner);
    if ((previous > 0) !== (next > 0)) for (const listener of this.presenceListeners.get(owner) ?? []) listener();
  }
  selectedProject(owner: string, placement: CreateDraftScope["placement"]): string | null {
    return this.selections.get(JSON.stringify([owner, placement]))?.project ?? null;
  }
  selectProject(scope: CreateDraftScope): void {
    if (!scope.project || !parseCreateComposerDraftKey(createComposerDraftKey(scope))) return;
    const key = JSON.stringify([scope.owner, scope.placement]);
    if (this.selections.get(key)?.project === scope.project) return;
    this.selections.delete(key);
    this.selections.set(key, scope);
    while (this.selections.size > MAX_CREATE_DRAFTS) this.selections.delete(this.selections.keys().next().value!);
    this.changed();
  }
  /** First-project selection transfers a pre-project draft atomically. An
   * existing destination always wins; the unattached draft stays recoverable. */
  adoptPending(key: string): CreateDraftRecord | undefined {
    const existing = this.get(key);
    if (existing) return existing;
    const pendingKey = pendingCreateComposerDraftKey(key);
    const pending = pendingKey ? this.records.get(pendingKey) : undefined;
    if (!pending || !pendingKey) return undefined;
    this.records.delete(pendingKey);
    this.records.set(key, pending);
    this.changed(pendingKey);
    this.changed(key);
    return pending.record;
  }
  subscribe(listener: (key: string) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  onError(listener: () => void): () => void {
    this.errorListeners.add(listener);
    return () => { this.errorListeners.delete(listener); };
  }
  set(key: string, draft: CreateComposerDraft): CreateDraftRecord | undefined {
    const scope = parseCreateComposerDraftKey(key);
    if (!scope) throw new Error("The Create draft has an invalid destination");
    if (draft.attachments.length > MAX_DRAFT_ATTACHMENTS) throw new Error("Too many attachments in this Create draft. Keep at most 1,000 files.");
    if (!validDirectories(draft.additionalDirectories)) throw new Error("Couldn't save linked directories in this Create draft. Keep at most 128 valid directory paths.");
    if (!hasPayload(draft)) { this.delete(key); return undefined; }
    const json = draftJson(draft);
    if (json.length > MAX_DRAFT_BYTES) throw new Error("This Create draft is too large to save on this device");
    const previous = this.records.get(key);
    if (previous?.json === json) return previous.record;
    if (!previous && this.records.size >= MAX_CREATE_DRAFTS) throw new Error("Too many saved Create drafts. Clear an unused draft before saving another.");
    let size = json.length + key.length;
    for (const [otherKey, value] of this.records) if (otherKey !== key) size += otherKey.length + value.json.length + 64;
    if (size > MAX_STORE_BYTES - 1024) throw new Error("Saved Create drafts are too large for this device. Clear an unused draft.");
    const record = { revision: ++this.revision, draft: JSON.parse(json) as CreateComposerDraft };
    this.records.set(key, { record, json });
    if (!hasPayload(previous?.record.draft)) this.changePresence(scope.owner, 1);
    this.changed(key);
    return record;
  }
  delete(key: string, revision?: number): boolean {
    const record = this.get(key);
    if (!record || revision !== undefined && record.revision !== revision) return false;
    this.records.delete(key);
    if (hasPayload(record.draft)) this.changePresence(parseCreateComposerDraftKey(key)!.owner, -1);
    this.changed(key);
    return true;
  }
  prune(remove: (scope: CreateDraftScope) => boolean): void {
    for (const key of this.records.keys()) {
      const scope = parseCreateComposerDraftKey(key);
      if (scope && remove(scope)) this.delete(key);
    }
    for (const [key, scope] of this.selections) if (remove(scope)) {
      this.selections.delete(key);
      this.changed();
    }
  }
  private changed(key?: string): void {
    this.dirty = true;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 500);
    if (key) for (const listener of this.listeners) listener(key);
  }
  flush(): boolean {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.dirty) return true;
    try {
      if (!this.storage) throw new Error("Storage unavailable");
      const snapshot = JSON.stringify({
        version: 1, entries: [...this.records].map(([key, value]) => [key, value.record]),
        selections: [...this.selections.values()].map(createComposerDraftKey),
      });
      if (snapshot.length > MAX_STORE_BYTES) throw new Error("Draft storage is full");
      this.storage.setItem(CREATE_DRAFT_STORAGE_KEY, snapshot);
      this.dirty = false;
      return true;
    } catch {
      for (const listener of this.errorListeners) listener();
      return false;
    }
  }
  dispose(): void { clearTimeout(this.timer); }
}
function browserStorage(): DraftStorage | undefined {
  try { return typeof localStorage === "undefined" ? undefined : localStorage; } catch { return undefined; }
}
export const createComposerDrafts = new CreateComposerDraftStore(browserStorage());
export function useCreateComposerHasDraft(owner: string | null): boolean {
  const subscribe = useCallback((listener: () => void) => createComposerDrafts.subscribePresence(owner, listener), [owner]);
  const snapshot = useCallback(() => createComposerDrafts.hasDraft(owner), [owner]);
  return useSyncExternalStore(subscribe, snapshot);
}
/** Membership reads are authoritative only for this account and backend. A
 * sign-out or an unrelated account's catalog must not discard unsent work. */
export function pruneCreateComposerOwners(backend: string | null, userId: string, organizationIds: readonly string[]): void {
  createComposerDrafts.prune(scope => {
    try {
      const owner: unknown = JSON.parse(scope.owner);
      return Array.isArray(owner) && owner.length === 3 && owner[0] === backend &&
        owner[1] === userId && !organizationIds.includes(owner[2]);
    } catch { return false; }
  });
  createComposerDrafts.flush();
}
// Registered at app startup, including when Create has never been mounted.
// Inactive drafts still own their recovery bytes after a restart.
const releaseSources = registerAttachmentSourceOwner(() => createComposerDrafts.drafts());
const flush = () => { createComposerDrafts.flush(); };
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flush);
  window.addEventListener("beforeunload", flush);
}
if (import.meta.hot) import.meta.hot.dispose(() => {
  flush();
  createComposerDrafts.dispose();
  releaseSources();
  window.removeEventListener("pagehide", flush);
  window.removeEventListener("beforeunload", flush);
});
