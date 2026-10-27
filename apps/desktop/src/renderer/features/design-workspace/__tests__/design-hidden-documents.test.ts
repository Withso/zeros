import { afterEach, expect, it, vi } from "vitest";
import { DesignHiddenDocuments } from "../state/design-hidden-documents";

afterEach(() => vi.useRealTimers());

it("prefers the latest hide even within one clock tick, and prunes deleted optional files", () => {
  vi.useFakeTimers();
  const store = new DesignHiddenDocuments({ graceMs: 100, maxHidden: 1 });
  const first = {}, second = {}, retire = vi.fn();
  const input = { owner: "local", active: true, files: new Set(["a"]), protectedFiles: [], retainAll: false };
  store.update(first, input, retire);
  store.update(first, { ...input, active: false }, retire);
  store.update(second, { ...input, owner: "organization", files: new Set(["b"]) }, retire);
  store.update(second, { ...input, owner: "organization", active: false, files: new Set(["b"]) }, retire);
  expect([...store.read(first)]).toEqual([]);
  expect([...store.read(second)]).toEqual(["b"]);
  store.update(second, { ...input, owner: "organization", active: false, available: [], files: new Set() }, retire);
  expect([...store.read(second)]).toEqual([]);
  expect(store.usage().warm).toBe(0);
});

it("keeps a quick return warm, then retires hidden documents without extending grace on renders", () => {
  vi.useFakeTimers();
  const store = new DesignHiddenDocuments({ graceMs: 100, maxHidden: 2 });
  const owner = {};
  const retire = vi.fn();
  const input = { owner: "personal/directory/page", active: true, files: new Set(["a", "b"]), protectedFiles: [], retainAll: false };
  store.update(owner, input, retire);
  store.update(owner, { ...input, active: false }, retire);
  vi.advanceTimersByTime(50);
  store.update(owner, input, retire);
  expect(retire).not.toHaveBeenCalled();
  store.update(owner, { ...input, active: false }, retire);
  vi.advanceTimersByTime(90);
  store.update(owner, { ...input, active: false }, retire);
  vi.advanceTimersByTime(10);
  expect([...store.read(owner)]).toEqual([]);
  expect(retire).toHaveBeenCalledWith(["a", "b"]);
  expect(store.usage()).toEqual({ active: 0, warm: 0, protected: 0 });
  store.remove(owner);
  expect(vi.getTimerCount()).toBe(0);
});

it("retires the oldest optional documents under shared pressure, protecting pending writes and IME", () => {
  vi.useFakeTimers();
  const store = new DesignHiddenDocuments({ graceMs: 100, maxHidden: 2 });
  const personal = {}, organization = {};
  const retire = vi.fn();
  const old = { owner: "personal/directory", active: true, files: new Set(["draft", "pending"]), protectedFiles: ["draft"], retainAll: true };
  store.update(personal, old, retire);
  store.update(personal, { ...old, active: false }, retire);
  const next = { owner: "organization/directory", active: true, files: new Set(["a", "b", "c"]), protectedFiles: [], retainAll: false };
  store.update(organization, next, retire);
  store.update(organization, { ...next, active: false }, retire);
  expect(store.usage()).toEqual({ active: 0, warm: 2, protected: 2 });
  vi.advanceTimersByTime(101);
  expect([...store.read(personal)]).toEqual(["draft", "pending"]);
  expect(store.read(organization).size).toBe(0);
  store.update(personal, { ...old, active: false, retainAll: false }, retire);
  expect([...store.read(personal)]).toEqual(["draft"]);
  store.update(personal, { ...old, active: false, retainAll: false, protectedFiles: [] }, retire);
  expect(store.read(personal).size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("bounds twenty owner visits and never transfers an old owner's documents", () => {
  vi.useFakeTimers();
  const store = new DesignHiddenDocuments({ graceMs: 100, maxHidden: 2 });
  const owner = {};
  const retire = vi.fn();
  for (let i = 0; i < 20; i++) {
    const input = { owner: `owner/${i}`, active: true, files: new Set([String(i)]), protectedFiles: [], retainAll: false };
    store.update(owner, input, retire);
    expect([...store.read(owner)]).toEqual([String(i)]);
    store.update(owner, { ...input, active: false }, retire);
    vi.advanceTimersByTime(100);
    expect(store.usage().warm).toBe(0);
  }
  store.remove(owner);
  expect(vi.getTimerCount()).toBe(0);
});
