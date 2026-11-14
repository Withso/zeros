import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { CloudRuntimeUpdateRequest, CloudRuntimeUpdateReply } from "@zeros/protocol/cloud-v2-relay";
import { RuntimeQuiescence, type RuntimeCensus } from "../runtime-quiescence";
import { RuntimeUpdate } from "../runtime-update";

afterEach(() => vi.restoreAllMocks());
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(flush = async () => {}, staging = false) {
  let now = 0, revision = "4";
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const census: RuntimeCensus = { clients: false, requests: false, agents: false, terminals: false, setup: false, checkout: false,
    configuration: false, prompts: false, attachments: false, storage: false, tools: false };
  const gate = new RuntimeQuiescence(() => census);
  const id = randomUUID(), sha256 = "b".repeat(64), seen: string[] = [];
  const request = vi.fn(async (input: CloudRuntimeUpdateRequest): Promise<CloudRuntimeUpdateReply> => {
    seen.push(input.op);
    if (input.op === "status") return { status: "target", sha256 };
    if (input.op === "prepare") return { status: "prepared", id, sha256 };
    if (input.op === "commit") return { status: "committed", id };
    if (input.op === "cancel") return { status: "cancelled", id };
    if (input.op === "stage") return { status: "staged", sha256 };
    return { status: "activating", id };
  });
  const permit = { arm: vi.fn(), revoke: vi.fn() };
  const updater = new RuntimeUpdate({ gate, permit, instanceId: randomUUID(), revision: () => revision, flush, request, staging: () => staging });
  const quiet = async () => { await updater.tick(); now = 30_000; };
  return { gate, updater, permit, seen, request, quiet, census, changeRevision: () => { revision = "5"; } };
}

it("commits only after the full quiet dwell and durable flush", async () => {
  const flushed: string[] = [], f = fixture(async () => { flushed.push("flushed"); });
  await f.quiet(); expect(f.seen).toEqual([]);
  await f.updater.tick();
  expect(f.seen).toEqual(["status", "prepare", "commit", "activate"]);
  expect(flushed).toEqual(["flushed"]);
  expect(f.permit.arm).toHaveBeenCalledOnce();
  f.updater.stop();
  expect(f.permit.revoke).toHaveBeenCalledOnce();
});

it.each(["admission", "revision", "storage", "stop"])("refuses %s arriving while final persistence is held", async kind => {
  const held = deferred(), entered = deferred(), f = fixture(async () => { entered.resolve(); await held.promise; });
  await f.quiet(); const updating = f.updater.tick(); await entered.promise;
  let admission: Promise<void> | undefined;
  if (kind === "admission") admission = Promise.resolve(f.gate.admit()).then(leave => { leave(); });
  if (kind === "revision") f.changeRevision();
  if (kind === "storage") f.census.storage = true;
  if (kind === "stop") f.updater.stop();
  held.resolve(); await updating; await admission;
  expect(f.seen).not.toContain("activate"); expect(f.seen).not.toContain("commit");
  f.updater.stop();
});

it("late activity during the commit response cancels before activation", async () => {
  const held = deferred(), entered = deferred(), f = fixture();
  const original = f.request.getMockImplementation()!;
  f.request.mockImplementation(async input => {
    const reply = await original(input);
    if (input.op === "commit") { entered.resolve(); await held.promise; }
    return reply;
  });
  await f.quiet(); const updating = f.updater.tick(); await entered.promise;
  const admission = Promise.resolve(f.gate.admit()).then(leave => leave());
  held.resolve(); await updating; await admission;
  expect(f.seen).toEqual(["status", "prepare", "commit", "cancel"]);
  f.updater.stop();
});

it("keeps late foreground work behind an activation whose response was lost", async () => {
  const f = fixture(), original = f.request.getMockImplementation()!;
  f.request.mockImplementation(async input => { const reply = await original(input); if (input.op === "activate") throw new Error("lost reply"); return reply; });
  await f.quiet(); await f.updater.tick();
  let ran = false;
  const admission = Promise.resolve(f.gate.admit()).then(leave => { ran = true; leave(); });
  await Promise.resolve(); expect(ran).toBe(false); expect(f.seen).not.toContain("cancel");
  f.updater.stop(); await admission;
});

it("never lets permit cleanup failure prevent synchronous Stop retirement", async () => {
  const f = fixture(); await f.quiet(); await f.updater.tick();
  f.permit.revoke.mockImplementation(() => { throw new Error("synthetic disk refusal"); });
  expect(() => f.updater.stop()).not.toThrow();
  await f.updater.tick();
  expect(f.seen.filter(op => op === "activate")).toHaveLength(1);
});

it("R1 push-signals-v1: with pushed hints the status check falls back to 15 min (no 1-min check), and a hint checks at once", async () => {
  let now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const census: RuntimeCensus = { clients: false, requests: false, agents: false, terminals: false, setup: false, checkout: false,
    configuration: false, prompts: false, attachments: false, storage: false, tools: false };
  const gate = new RuntimeQuiescence(() => census);
  const request = vi.fn(async (_input: CloudRuntimeUpdateRequest): Promise<CloudRuntimeUpdateReply> => ({ status: "current" }));
  const updater = new RuntimeUpdate({ gate, permit: { arm: vi.fn(), revoke: vi.fn() }, instanceId: randomUUID(), revision: () => "4", flush: async () => {}, request });
  const statuses = () => request.mock.calls.filter(([input]) => input.op === "status").length;
  updater.setPushSignals(true);
  await updater.tick(); now = 30_000; await updater.tick();
  expect(statuses()).toBe(1);
  now = 30_000 + 60_000; await updater.tick();
  expect(statuses()).toBe(1);
  now = 30_000 + 900_000; await updater.tick();
  expect(statuses()).toBe(2);
  updater.hint(); await updater.tick();
  expect(statuses()).toBe(3);
  // Without pushed hints, the 1-minute check stays.
  updater.setPushSignals(false);
  now += 60_000; await updater.tick();
  expect(statuses()).toBe(4);
  updater.stop();
});

it("runtime-staging-v1: stages the target at once while busy, once per target, then hands off only when quiet", async () => {
  const f = fixture(async () => {}, true);
  // A connected client and a running turn: not quiet. Staging still happens immediately and does not postpone.
  f.census.clients = true; f.census.agents = true;
  await f.updater.tick();
  expect(f.seen).toEqual(["status", "stage"]);
  f.updater.hint(); await f.updater.tick();
  expect(f.seen).toEqual(["status", "stage", "status"]);
  expect(f.permit.arm).not.toHaveBeenCalled();
  // Quiet later: the ordinary quiet path prepares (reusing the staged bytes on the control plane), commits and activates.
  f.census.clients = false; f.census.agents = false;
  await f.quiet(); f.updater.hint(); await f.updater.tick();
  expect(f.seen.slice(3)).toEqual(["status", "prepare", "commit", "activate"]);
  f.updater.stop();
});

it("without runtime-staging-v1 (older control plane) nothing is staged and the quiet path is unchanged", async () => {
  const f = fixture();
  f.census.clients = true;
  await f.updater.tick();
  expect(f.seen).toEqual([]);
  f.updater.stop();
});
