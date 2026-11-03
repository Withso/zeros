import { isCloudWorkspace } from "@/renderer/platform/bridge/cloud-workspace-key";
import { CONTROL_PLANE_URL } from "@/renderer/features/team/control-plane";
import { getTeamStoreState } from "@/renderer/features/team/team-store";

/** Unsaved editor text kept outside the renderer's memory, so closing a tab or
 * the window, quitting, updating or archiving never discards it. `base` is the
 * file content the draft was edited from: a reopened file restores the draft
 * only while the file still holds that content. */
export interface EditorDraft {
  key: string;
  base: string;
  draft: string;
  updatedAt: number;
}

export interface EditorDraftJournal {
  read(key: string): Promise<EditorDraft | undefined>;
  write(draft: EditorDraft): Promise<void>;
  remove(key: string): Promise<void>;
}

const RETAIN_MS = 30 * 24 * 60 * 60_000;
const MAX_ENTRIES = 100;
const MAX_TOTAL_CHARS = 32 * 1024 * 1024;

/** Cloud drafts belong to the signed-in account that edited them, so another
 * account on this Mac never restores them. Without that identity nothing is
 * kept. Local files are already this Mac's own. */
export function editorDraftKey(cwd: string, path: string): string | null {
  if (!cwd || !path) return null;
  if (!isCloudWorkspace(cwd)) return JSON.stringify(["local", cwd, path]);
  const accountId = getTeamStoreState().me?.user.id;
  return CONTROL_PLANE_URL && accountId
    ? JSON.stringify(["cloud", CONTROL_PLANE_URL, accountId, cwd, path])
    : null;
}

function prune(rows: EditorDraft[], now: number): string[] {
  const doomed = new Set(rows.filter(row => now - row.updatedAt > RETAIN_MS).map(row => row.key));
  let chars = 0;
  let kept = 0;
  for (const row of [...rows].sort((a, b) => b.updatedAt - a.updatedAt)) {
    if (doomed.has(row.key)) continue;
    chars += row.base.length + row.draft.length;
    kept += 1;
    if (kept > MAX_ENTRIES || chars > MAX_TOTAL_CHARS) doomed.add(row.key);
  }
  return [...doomed];
}

export function createIndexedDbDraftJournal(factory: IDBFactory): EditorDraftJournal {
  let database: Promise<IDBDatabase> | null = null;
  const open = () => database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open("zeros:editor-drafts:v1", 1);
    request.onupgradeneeded = () => { request.result.createObjectStore("drafts", { keyPath: "key" }); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { database = null; reject(request.error ?? new Error("Editor drafts are unavailable")); };
  });
  const run = async <T>(mode: IDBTransactionMode, body: (store: IDBObjectStore, done: (value: T) => void) => void) => {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(["drafts"], mode);
      let value: T;
      tx.oncomplete = () => resolve(value);
      tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("Editor draft transaction failed"));
      body(tx.objectStore("drafts"), result => { value = result; });
    });
  };
  return {
    read: key => run<EditorDraft | undefined>("readonly", (store, done) => {
      const request = store.get(key);
      request.onsuccess = () => done(request.result as EditorDraft | undefined);
    }),
    write: draft => run<void>("readwrite", (store, done) => {
      store.put(draft);
      const all = store.getAll();
      all.onsuccess = () => {
        for (const key of prune(all.result as EditorDraft[], draft.updatedAt)) if (key !== draft.key) store.delete(key);
        done(undefined);
      };
    }),
    remove: key => run<void>("readwrite", (store, done) => { store.delete(key); done(undefined); }),
  };
}

export function createMemoryDraftJournal(): EditorDraftJournal {
  const rows = new Map<string, EditorDraft>();
  return {
    read: async key => { const row = rows.get(key); return row && { ...row }; },
    write: async draft => {
      rows.set(draft.key, { ...draft });
      for (const key of prune([...rows.values()], draft.updatedAt)) if (key !== draft.key) rows.delete(key);
    },
    remove: async key => { rows.delete(key); },
  };
}

let journal: EditorDraftJournal | null = null;
export function editorDraftJournal(): EditorDraftJournal {
  return journal ??= typeof indexedDB === "undefined"
    ? createMemoryDraftJournal()
    : createIndexedDbDraftJournal(indexedDB);
}

/** Tests replace the process journal; production never calls this. */
export function setEditorDraftJournalForTests(next: EditorDraftJournal | null): void {
  journal = next;
}

const forgotten = new Set<string>();

/** An explicit discard of the file itself retires any kept draft for it. The
 * editor it replaces may still flush that draft while unmounting, so the next
 * editor for the path removes it again instead of offering it back. */
export function forgetEditorDraft(cwd: string, path: string): void {
  const key = editorDraftKey(cwd, path);
  if (!key) return;
  forgotten.add(key);
  void editorDraftJournal().remove(key).catch(() => {});
}

export function consumeForgottenEditorDraft(key: string): boolean {
  return forgotten.delete(key);
}
