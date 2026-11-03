import { describe, expect, it, vi } from "vitest";

const team = vi.hoisted(() => ({ account: "account-a" as string | undefined }));
vi.mock("@/renderer/features/team/team-store", () => ({ getTeamStoreState: () => ({ me: team.account ? { user: { id: team.account } } : null }) }));
vi.mock("@/renderer/features/team/control-plane", () => ({ CONTROL_PLANE_URL: "https://control.example.test" }));

import {
  consumeForgottenEditorDraft,
  createIndexedDbDraftJournal,
  editorDraftKey,
  forgetEditorDraft,
  setEditorDraftJournalForTests,
  createMemoryDraftJournal,
  type EditorDraft,
} from "../draft-journal";

/** One object store with committed-on-complete transactions, enough to drive
 * the production IndexedDB journal through its real request callbacks. */
function database() {
  const rows = new Map<string, EditorDraft>();
  const factory = { open() {
    const request: any = {};
    queueMicrotask(() => {
      request.result = {
        createObjectStore() { return {}; },
        transaction() {
          const copy = new Map(rows);
          let pending = 0;
          const tx: any = {};
          const run = (fn: () => unknown) => {
            pending += 1;
            const r: any = {};
            queueMicrotask(() => {
              r.result = structuredClone(fn());
              pending -= 1;
              r.onsuccess?.();
              queueMicrotask(() => {
                if (pending) return;
                rows.clear();
                for (const [key, value] of copy) rows.set(key, value);
                tx.oncomplete?.();
              });
            });
            return r;
          };
          tx.objectStore = () => ({
            get: (key: string) => run(() => copy.get(key)),
            getAll: () => run(() => [...copy.values()]),
            put: (row: EditorDraft) => run(() => { copy.set(row.key, structuredClone(row)); }),
            delete: (key: string) => run(() => { copy.delete(key); }),
          });
          return tx;
        },
      };
      request.onupgradeneeded?.();
      request.onsuccess?.();
    });
    return request;
  } } as unknown as IDBFactory;
  return { factory, rows };
}

describe("editor draft journal", () => {
  it("reads, overwrites and removes drafts through IndexedDB", async () => {
    const { factory } = database();
    const journal = createIndexedDbDraftJournal(factory);
    await journal.write({ key: "k", base: "a", draft: "a1", updatedAt: 1 });
    await journal.write({ key: "k", base: "a", draft: "a12", updatedAt: 2 });
    expect(await journal.read("k")).toEqual({ key: "k", base: "a", draft: "a12", updatedAt: 2 });
    await journal.remove("k");
    expect(await journal.read("k")).toBeUndefined();
  });

  it("prunes drafts older than 30 days and beyond 100 entries, never the one just written", async () => {
    const { factory, rows } = database();
    const journal = createIndexedDbDraftJournal(factory);
    const now = 40 * 24 * 60 * 60_000;
    await journal.write({ key: "stale", base: "", draft: "x", updatedAt: 1 });
    for (let index = 0; index < 101; index += 1)
      await journal.write({ key: `k${index}`, base: "", draft: "x", updatedAt: now + index });
    expect(rows.has("stale")).toBe(false);
    expect(rows.size).toBe(100);
    expect(rows.has("k0")).toBe(false);
    expect(rows.has("k100")).toBe(true);
  });

  it("scopes cloud drafts to the signed-in account and keeps none without one", () => {
    expect(editorDraftKey("/personal/a", "f.ts")).toBe(JSON.stringify(["local", "/personal/a", "f.ts"]));
    const a = editorDraftKey("cloud://organization/a", "f.ts");
    team.account = "account-b";
    expect(editorDraftKey("cloud://organization/a", "f.ts")).not.toBe(a);
    team.account = undefined;
    expect(editorDraftKey("cloud://organization/a", "f.ts")).toBeNull();
    team.account = "account-a";
  });

  it("forgets a discarded file's draft and tells the next editor to remove a late flush", async () => {
    const journal = createMemoryDraftJournal();
    setEditorDraftJournalForTests(journal);
    const key = editorDraftKey("/personal/a", "f.ts")!;
    await journal.write({ key, base: "a", draft: "a1", updatedAt: 1 });
    forgetEditorDraft("/personal/a", "f.ts");
    await Promise.resolve();
    expect(await journal.read(key)).toBeUndefined();
    expect(consumeForgottenEditorDraft(key)).toBe(true);
    expect(consumeForgottenEditorDraft(key)).toBe(false);
    setEditorDraftJournalForTests(null);
  });
});
