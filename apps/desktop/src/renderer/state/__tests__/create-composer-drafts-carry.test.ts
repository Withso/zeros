import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CreateComposerDraftStore,
  createComposerDraftKey,
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

const cloudOwner = JSON.stringify(["https://alpha.example.test", "a", "org"]);

describe("Create drafts across the placement control", () => {
  it("moves the unsent draft to the destination it now shows, and back", () => {
    const store = open();
    const mac = key("local", "/project", "local");
    const cloud = key(cloudOwner, "repo-1", "cloud");
    store.set(mac, draft("ship it"));
    expect(store.carry(mac, cloud)).toBe(true);
    expect(store.get(mac)).toBeUndefined();
    expect(store.get(cloud)?.draft.text).toBe("ship it");
    expect(store.hasDraft("local")).toBe(false);
    expect(store.hasDraft(cloudOwner)).toBe(true);
    expect(store.carry(cloud, mac)).toBe(true);
    expect(store.get(mac)?.draft.text).toBe("ship it");
  });

  it("keeps an existing destination draft and leaves the source where it was", () => {
    const store = open();
    const mac = key("local", "/project", "local");
    const cloud = key(cloudOwner, "repo-1", "cloud");
    store.set(mac, draft("new"));
    store.set(cloud, draft("older"));
    expect(store.carry(mac, cloud)).toBe(false);
    expect(store.get(mac)?.draft.text).toBe("new");
    expect(store.get(cloud)?.draft.text).toBe("older");
  });

  it("ignores empty sources and malformed keys", () => {
    const store = open();
    const mac = key("local", "/project", "local");
    expect(store.carry(mac, key(cloudOwner, "repo-1", "cloud"))).toBe(false);
    store.set(mac, draft("text"));
    expect(store.carry(mac, "not a key")).toBe(false);
    expect(store.get(mac)?.draft.text).toBe("text");
  });

  it("persists the moved draft under its new key", () => {
    const disk = storage();
    const store = open(disk);
    const mac = key("local", "/project", "local");
    const cloud = key(cloudOwner, "repo-1", "cloud");
    store.set(mac, draft("survives restart"));
    store.carry(mac, cloud);
    store.flush();
    const reopened = open(disk);
    expect(reopened.get(cloud)?.draft.text).toBe("survives restart");
    expect(reopened.get(mac)).toBeUndefined();
  });
});
