import { expect, it, vi } from "vitest";
import { DesignSavedEditingSession } from "../design-saved-editing";

function held() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

it.each(["local-personal", "organization-local", "cloud://org/workspace"])("keeps the no-draft path synchronous for %s", (owner) => {
  let currentOwner = owner;
  const session = new DesignSavedEditingSession(() => currentOwner === owner);
  session.registerPreparation(() => {});
  expect(session.enter()).toBe(true);
  expect(session.snapshot()).toBe(2);
  currentOwner = "retired";
  expect(session.enter()).toBe(false);
});

it("lets an explicit retry replace an obsolete pending preparation with synchronous readiness", () => {
  let failed = true;
  const pending = held();
  const session = new DesignSavedEditingSession(() => true);
  session.registerPreparation(() => { if (failed) throw new Error("restore failed"); });
  session.registerPreparation(() => failed ? pending.promise : undefined);
  expect(session.enter()).toBe(false);
  failed = false;
  expect(session.enter()).toBe(true);
  pending.resolve();
});

it("waits for every physical preparation and rejects an obsolete runtime completion", async () => {
  const session = new DesignSavedEditingSession(() => true);
  const old = held(), current = held();
  const remove = session.registerPreparation(() => old.promise);
  expect(session.enter()).toBe(false);
  remove();
  session.registerPreparation(() => current.promise);
  old.resolve();
  await old.promise;
  expect(session.snapshot()).toBe(1);
  current.resolve();
  await vi.waitFor(() => expect(session.snapshot()).toBe(2));
});

it("never turns failed restoration into edit authority", async () => {
  const session = new DesignSavedEditingSession(() => true);
  const restore = held();
  session.registerPreparation(() => restore.promise);
  expect(session.enter()).toBe(false);
  restore.reject(new Error("Failed restoration"));
  await vi.waitFor(() => expect(session.snapshot()).toBe(1));
  expect(session.enter()).toBe(false);
});

it("retires held readiness across owner A to B to A", async () => {
  let owner = "A";
  const session = new DesignSavedEditingSession(() => owner === "A");
  const restore = held();
  session.registerPreparation(() => restore.promise);
  session.enter();
  owner = "B";
  session.retire();
  owner = "A";
  restore.resolve();
  await restore.promise;
  expect(session.enter()).toBe(false);
  expect(session.snapshot()).toBe(0);
});

it("keeps saved pixels until completed saves drain before restoring passive drafts", async () => {
  const session = new DesignSavedEditingSession(() => true);
  const save = held();
  session.enter();
  session.retain(save.promise);
  session.leave();
  await Promise.resolve();
  expect(session.editing).toBe(true);
  save.resolve();
  await vi.waitFor(() => expect(session.snapshot()).toBe(0));
});

it("does not let a stale passive-view acknowledgement end newer editing", async () => {
  const session = new DesignSavedEditingSession(() => true);
  const save = held();
  session.enter();
  session.retain(save.promise);
  session.leave();
  await Promise.resolve();
  session.enter();
  save.resolve();
  await save.promise;
  expect(session.editing).toBe(true);
});
