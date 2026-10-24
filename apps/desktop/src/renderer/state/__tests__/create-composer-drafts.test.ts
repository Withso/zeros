import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CreateComposerDraftStore,
  createComposerDraftKey,
  createComposerDraftOwner,
  CREATE_DRAFT_STORAGE_KEY,
  MAX_CREATE_DRAFTS,
} from "../create-composer-drafts";
import type { ComposerDraft } from "../store";

const stores: CreateComposerDraftStore[] = [];
afterEach(() => stores.splice(0).forEach(store => store.dispose()));
function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
  };
}
function open(disk = storage()) {
  const store = new CreateComposerDraftStore(disk);
  stores.push(store);
  return store;
}
const key = (owner = "local", project = "/project", placement: "local" | "cloud" = "local") =>
  createComposerDraftKey({ owner, project, placement });
const draft = (text: string): ComposerDraft => ({ text, json: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] }, attachments: [] });

describe("Create drafts before a workspace exists", () => {
  it("uses the same durable owner for Create and its sidebar indicator", () => {
    expect(createComposerDraftOwner({ backend: "https://alpha.example.test", userId: "a", organizationId: null })).toBe("local");
    expect(createComposerDraftOwner({ backend: null, userId: null, organizationId: null })).toBe("local");
    expect(createComposerDraftOwner({ backend: null, userId: null, organizationId: "org" })).toBeNull();
    const owner = createComposerDraftOwner({ backend: "https://alpha.example.test", userId: "a", organizationId: "org" });
    expect(owner).toBe(JSON.stringify(["https://alpha.example.test", "a", "org"]));
    expect(createComposerDraftOwner({ backend: "https://alpha.example.test", userId: "b", organizationId: "org" })).not.toBe(owner);
    expect(createComposerDraftOwner({ backend: "https://another.example.test", userId: "a", organizationId: "org" })).not.toBe(owner);
  });

  it("restores owner presence for text and pill-only drafts without treating whitespace as a draft", () => {
    const disk = storage();
    const attachment = { ...draft(""), attachments: [{ id: "file", name: "notes.md", kind: "file" as const, mimeType: "text/markdown", size: 0, data: "", validation: { ok: true as const } }] };
    disk.setItem(CREATE_DRAFT_STORAGE_KEY, JSON.stringify({ version: 1, entries: [
      [key("empty"), { revision: 1, draft: draft(" \n ") }],
      [key("local"), { revision: 2, draft: draft("@src/App.tsx") }],
      [key("org-a", "repo", "cloud"), { revision: 3, draft: attachment }],
      [key("org-b", "/project"), { revision: 4, draft: draft("/review-agent") }],
    ] }));
    const store = open(disk);
    expect(store.hasDraft(null)).toBe(false);
    expect(store.hasDraft("empty")).toBe(false);
    expect(store.hasDraft("local")).toBe(true);
    expect(store.hasDraft("org-a")).toBe(true);
    expect(store.hasDraft("org-b")).toBe(true);
    expect(store.hasDraft("another-owner")).toBe(false);
  });

  it("publishes only owner empty/nonempty transitions across projects and placements", () => {
    const store = open();
    const seen: boolean[] = [];
    const stop = store.subscribePresence("org-a", () => seen.push(store.hasDraft("org-a")));
    const first = store.set(key("org-a"), draft("first"))!;
    store.set(key("org-a"), draft("more typing"));
    store.set(key("org-a", "repo", "cloud"), draft("cloud"));
    store.selectProject({ owner: "org-a", placement: "cloud", project: "repo" });
    store.set(key("org-b"), draft("another owner"));
    expect(store.delete(key("org-a"), first.revision)).toBe(false);
    expect(seen).toEqual([true]);
    store.delete(key("org-a"));
    expect(seen).toEqual([true]);
    store.set(key("org-a", "repo", "cloud"), draft(" \n "));
    expect(seen).toEqual([true, false]);
    expect(store.hasDraft("org-b")).toBe(true);
    stop();
    store.set(key("org-a"), draft("after unsubscribe"));
    expect(seen).toEqual([true, false]);
  });

  it("keeps presence through pending-project adoption and failed persistence, and prunes only the removed owner", () => {
    const disk = storage(), store = open(disk);
    const seen: boolean[] = [];
    store.subscribePresence("local", () => seen.push(store.hasDraft("local")));
    store.set(createComposerDraftKey({ owner: "local", placement: "local", project: null }), draft("before choosing"));
    store.adoptPending(key());
    expect(seen).toEqual([true]);
    disk.setItem.mockImplementationOnce(() => { throw new Error("quota"); });
    expect(store.flush()).toBe(false);
    expect(store.hasDraft("local")).toBe(true);
    store.set(key("org-a", "repo", "cloud"), draft("cloud draft"));
    store.prune(scope => scope.owner === "local");
    expect(seen).toEqual([true, false]);
    expect(store.hasDraft("org-a")).toBe(true);
  });

  it("restores text, editor order and attachment recovery metadata after restart, without serializing bytes", () => {
    const disk = storage(), first = open(disk);
    const input = draft("read this");
    input.attachments = [{ id: "att-1", name: "notes.md", mimeType: "text/markdown", size: 12,
      kind: "file", data: "secret-inline-bytes", text: "secret-inline-text", sourceFile: new Blob(["file bytes"]),
      sourceRecoveryId: "a".repeat(36), validation: { ok: true }, delivery: "reference" }];
    first.set(key(), input);
    expect(first.flush()).toBe(true);
    const raw = disk.getItem(CREATE_DRAFT_STORAGE_KEY)!;
    expect(raw).not.toContain("secret-inline");
    expect(raw).not.toContain("sourceFile");
    const restored = open(disk).get(key())!;
    expect(restored.draft.text).toBe("read this");
    expect(restored.draft.json).toEqual(input.json);
    expect(restored.draft.attachments[0]).toMatchObject({ sourceRecoveryId: "a".repeat(36), name: "notes.md" });
    expect(restored.draft.attachments[0].sourceFile).toBeUndefined();
  });

  it("recovers linked directories with their scoped document, including directory-only drafts", () => {
    const disk = storage(), store = open(disk);
    const input = { ...draft(""), additionalDirectories: ["/shared/library"] };
    const record = store.set(key(), input);
    expect(record).toBeDefined();
    expect(store.hasDraft("local")).toBe(true);
    store.flush();
    const restored = open(disk);
    expect(restored.get(key())?.draft).toMatchObject({ additionalDirectories: input.additionalDirectories });
    expect(restored.hasDraft("local")).toBe(true);
    expect(restored.get(key("org-a", "example/repo", "cloud"))).toBeUndefined();
    expect(restored.get(key("local", "/other"))).toBeUndefined();
    restored.set(key(), { ...input, additionalDirectories: [] });
    expect(restored.hasDraft("local")).toBe(false);
    restored.flush();
    expect(open(disk).get(key())).toBeUndefined();
  });

  it("validates linked-directory recovery metadata without losing legacy drafts", () => {
    const disk = storage();
    const entries = [
      [key(), { revision: 1, draft: draft("legacy") }],
      [key("local", "/invalid"), { revision: 2, draft: { ...draft("invalid"), additionalDirectories: [null] } }],
    ];
    disk.setItem(CREATE_DRAFT_STORAGE_KEY, JSON.stringify({ version: 1, entries }));
    const store = open(disk);
    expect(store.get(key())?.draft.text).toBe("legacy");
    expect(store.get(key("local", "/invalid"))).toBeUndefined();
  });

  it("bounds linked-directory metadata and revisions directory-only edits", () => {
    const disk = storage(), store = open(disk);
    const first = store.set(key(), { ...draft(""), additionalDirectories: ["/shared/first"] })!;
    const latest = store.set(key(), { ...draft(""), additionalDirectories: ["/shared/second"] })!;
    expect(store.delete(key(), first.revision)).toBe(false);
    expect(store.get(key())).toBe(latest);
    expect(() => store.set(key(), { ...draft(""), additionalDirectories: Array.from({ length: 129 }, (_, i) => `/shared/${i}`) })).toThrow(/linked directories/);
    store.flush();
    expect(open(disk).get(key())?.draft.additionalDirectories).toEqual(["/shared/second"]);
  });

  it("isolates Local, organization-local, cloud, projects and account owners through A -> B -> A", () => {
    const disk = storage(), store = open(disk);
    const keys = [key(), key("org-a"), key("org-a", "/project", "cloud"), key("org-a", "/another", "cloud"), key("org-b", "/project", "cloud")];
    keys.forEach((scope, i) => store.set(scope, draft(`draft ${i}`)));
    store.flush();
    const restored = open(disk);
    keys.forEach((scope, i) => expect(restored.get(scope)?.draft.text).toBe(`draft ${i}`));
    expect(restored.get(key("other-account"))).toBeUndefined();
  });

  it("a late successful Create only consumes the exact submitted revision", () => {
    const store = open();
    const submitted = store.set(key(), draft("submitted"))!;
    const newer = store.set(key(), draft("typed during creation"))!;
    expect(store.delete(key(), submitted.revision)).toBe(false);
    expect(store.get(key())).toBe(newer);
    expect(store.delete(key(), newer.revision)).toBe(true);
    expect(store.get(key())).toBeUndefined();
  });

  it("recovers typing before a project exists and adopts it only into an empty draft for the same owner and placement", () => {
    const disk = storage(), store = open(disk);
    const pending = createComposerDraftKey({ owner: "local", placement: "local", project: null });
    store.set(pending, draft("before adding a project"));
    store.flush();
    const restored = open(disk);
    expect(restored.adoptPending(key("org-a"))).toBeUndefined();
    expect(restored.get(pending)?.draft.text).toBe("before adding a project");
    restored.set(key(), draft("existing project draft"));
    expect(restored.adoptPending(key())?.draft.text).toBe("existing project draft");
    expect(restored.get(pending)).toBeDefined();
    expect(restored.adoptPending(key("local", "/new"))?.draft.text).toBe("before adding a project");
    expect(restored.get(pending)).toBeUndefined();
    restored.flush();
    expect(open(disk).get(key("local", "/new"))?.draft.text).toBe("before adding a project");
  });

  it("restores selected projects and prunes drafts and selections only for the removed scope", () => {
    const disk = storage(), store = open(disk);
    const scopes = [
      { owner: "local", project: "/a", placement: "local" as const },
      { owner: "org-a", project: "example/a", placement: "cloud" as const },
      { owner: "org-b", project: "example/a", placement: "cloud" as const },
    ];
    for (const scope of scopes) {
      store.set(createComposerDraftKey(scope), draft(scope.owner));
      store.selectProject(scope);
    }
    store.flush();
    const restored = open(disk);
    expect(restored.selectedProject("local", "local")).toBe("/a");
    restored.prune(scope => scope.owner === "org-a");
    expect(restored.selectedProject("org-a", "cloud")).toBeNull();
    expect(restored.get(createComposerDraftKey(scopes[1]))).toBeUndefined();
    expect(restored.get(createComposerDraftKey(scopes[2]))?.draft.text).toBe("org-b");
  });

  it("does not change a revision for identical editor updates, and persists clearing", () => {
    const disk = storage(), store = open(disk);
    const first = store.set(key(), draft("hello"));
    expect(store.set(key(), draft("hello"))).toBe(first);
    store.flush();
    store.set(key(), { text: "  ", json: null, attachments: [] });
    store.flush();
    expect(open(disk).get(key())).toBeUndefined();
  });

  it("retains inactive attachment source owners until the draft is consumed", () => {
    const store = open();
    const input = draft("later");
    input.attachments = [{ id: "att-1", name: "clip.txt", size: 0, kind: "file", mimeType: "text/plain", data: "", sourceRecoveryId: "b".repeat(36), validation: { ok: true } }];
    store.set(key(), input);
    expect(store.drafts()[0].attachments[0].sourceRecoveryId).toBe("b".repeat(36));
    store.delete(key());
    expect(store.drafts()).toEqual([]);
  });

  it("bounds retained drafts without evicting someone else's unsent work", () => {
    const store = open();
    for (let i = 0; i < MAX_CREATE_DRAFTS; i++) store.set(key("local", `/repo-${i}`), draft(`draft ${i}`));
    expect(() => store.set(key("local", "/overflow"), draft("new"))).toThrow(/saved Create drafts/);
    expect(store.get(key("local", "/repo-0"))?.draft.text).toBe("draft 0");
    expect(() => store.set(key("local", "/repo-0"), draft("updated"))).not.toThrow();
  });

  it("keeps memory and the last disk snapshot when persistence fails, then retries", () => {
    const disk = storage(), store = open(disk);
    store.set(key(), draft("old"));
    store.flush();
    disk.setItem.mockImplementationOnce(() => { throw new Error("quota"); });
    store.set(key(), draft("new"));
    expect(store.flush()).toBe(false);
    expect(store.get(key())?.draft.text).toBe("new");
    expect(open(disk).get(key())?.draft.text).toBe("old");
    expect(store.flush()).toBe(true);
    expect(open(disk).get(key())?.draft.text).toBe("new");
  });

  it("ignores malformed records and refuses oversized documents without replacing the last draft", () => {
    const disk = storage();
    disk.setItem(CREATE_DRAFT_STORAGE_KEY, JSON.stringify({ version: 1, entries: [["bad-key", {}], [key(), { revision: 1, draft: { text: 1, attachments: [] } }]] }));
    const store = open(disk);
    expect(store.drafts()).toEqual([]);
    store.set(key(), draft("good"));
    expect(() => store.set(key(), draft("x".repeat(2_000_000)))).toThrow(/too large/);
    expect(store.get(key())?.draft.text).toBe("good");
  });

  it("refuses more attachment metadata than it can recover after restart without replacing the saved draft", () => {
    const disk = storage(), store = open(disk);
    store.set(key(), draft("saved work"));
    store.flush();
    const next = draft("too many files");
    next.attachments = Array.from({ length: 1001 }, (_, index) => ({
      id: `att-${index}`, name: `${index}.txt`, mimeType: "text/plain", size: 0,
      kind: "file", data: "", validation: { ok: true },
    }));
    expect(() => store.set(key(), next)).toThrow(/too many attachments/i);
    store.flush();
    expect(open(disk).get(key())?.draft.text).toBe("saved work");
  });
});
