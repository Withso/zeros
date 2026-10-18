import { describe, expect, it, vi } from "vitest";

import type { UplinkSession } from "./uplink-server.js";
import { UplinkTurnJournal, type UplinkTurnRecord, type UplinkTurnStore } from "./uplink-turns.js";

const identity = { workspaceId: "00000000-0000-4000-8000-000000000001", organizationId: "00000000-0000-4000-8000-000000000002",
  generation: 1, engineInstanceId: "00000000-0000-4000-8000-000000000003", bootId: "00000000-0000-4000-8000-000000000004" };
const event = (journalSeq: number, extra: Record<string, unknown> = {}) =>
  ({ journalSeq, chatId: "chat", turnId: `turn-${journalSeq}`, state: "completed", atMs: 1_000, ...extra });
function session() {
  const reliable: [string, Record<string, unknown>][] = [], errors: [string, Record<string, unknown> | undefined][] = [];
  const value: UplinkSession = { connectionId: "c-1", identity, features: new Set(["turns.v1"]),
    sendReliable: (t, d) => { reliable.push([t, d]); return true; },
    sendError: (code, _message, extra) => { errors.push([code, extra]); } };
  return { value, reliable, errors };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe("uplink turn journal", () => {
  it("is turns.v1 behind turn_journal and claims only turns.event", () => {
    const journal = new UplinkTurnJournal({ store: { record: async () => ({ result: "stored" }) } });
    expect([journal.feature, journal.flag]).toEqual(["turns.v1", "turn_journal"]);
    expect(journal.onFrame(session().value, "cred.ack", {})).toBe(false);
  });
  it.each([event(0), event(1, { chatId: "a b" }), event(1, { state: "cancelled" }), event(1, { actorUserId: "x" }), { journalSeq: 1 }])(
    "refuses an invalid event %#", d => {
      const journal = new UplinkTurnJournal({ store: { record: async () => ({ result: "stored" }) } });
      expect(journal.onFrame(session().value, "turns.event", d)).toBe("invalid");
    });
  it("records one event at a time in receive order and acks stored and duplicate events", async () => {
    const resolvers: ((value: UplinkTurnRecord) => void)[] = [];
    const record = vi.fn<UplinkTurnStore["record"]>(() => new Promise(resolve => { resolvers.push(resolve); }));
    const journal = new UplinkTurnJournal({ store: { record } }), s = session();
    expect(journal.onFrame(s.value, "turns.event", event(1))).toBe(true);
    expect(journal.onFrame(s.value, "turns.event", event(2))).toBe(true);
    await settle(); expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]).toEqual([identity, event(1)]);
    resolvers[0]!({ result: "stored" }); await settle();
    resolvers[1]!({ result: "duplicate" }); await settle();
    expect(s.reliable).toEqual([["turns.ack", { journalSeq: 1 }], ["turns.ack", { journalSeq: 2 }]]);
  });
  it("reports a gap once per expected sequence and acks nothing for a gap or an unavailable store", async () => {
    const outcomes: UplinkTurnRecord[] = [{ result: "gap", expectedJournalSeq: 2 }, { result: "gap", expectedJournalSeq: 2 },
      { result: "unavailable" }, { result: "gap", expectedJournalSeq: 3 }];
    const journal = new UplinkTurnJournal({ store: { record: async () => outcomes.shift()! } }), s = session();
    for (const seq of [4, 5, 6, 7]) journal.onFrame(s.value, "turns.event", event(seq));
    await settle(); await settle();
    expect(s.reliable).toEqual([]);
    expect(s.errors).toEqual([["turn_journal_gap", { expectedJournalSeq: 2 }], ["turn_journal_gap", { expectedJournalSeq: 3 }]]);
  });
  it("drops events beyond 128 pending and survives a throwing store", async () => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const journal = new UplinkTurnJournal({ store: { record: async () => {
      calls += 1; await gate; if (calls === 1) throw new Error("boom"); return { result: "stored" }; } } }), s = session();
    for (let seq = 1; seq <= 130; seq++) expect(journal.onFrame(s.value, "turns.event", event(seq))).toBe(true);
    release(); for (let i = 0; i < 10; i++) await settle();
    expect(calls).toBe(128);
    expect(s.reliable).toHaveLength(127);
  });
  it("stores at most 128 events at once and 10 per second after that", async () => {
    let now = 0;
    const record = vi.fn(async () => ({ result: "stored" as const }));
    const journal = new UplinkTurnJournal({ store: { record }, now: () => now }), s = session();
    for (let seq = 1; seq <= 128; seq++) journal.onFrame(s.value, "turns.event", event(seq));
    for (let i = 0; i < 5; i++) await settle();
    expect(record).toHaveBeenCalledTimes(128);
    journal.onFrame(s.value, "turns.event", event(129));
    for (let i = 0; i < 3; i++) await settle();
    expect(record).toHaveBeenCalledTimes(128);
    now = 1_000;
    for (let seq = 129; seq <= 140; seq++) journal.onFrame(s.value, "turns.event", event(seq));
    for (let i = 0; i < 5; i++) await settle();
    expect(record).toHaveBeenCalledTimes(138);
  });
});
