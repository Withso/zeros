import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TRANSCRIPT_CHAT_BYTES,
  TRANSCRIPT_CHAT_ROWS,
  TRANSCRIPT_PAGE_DESCRIPTOR_BYTES,
  TRANSCRIPT_PAGE_ROWS,
  TRANSCRIPT_PAGE_SLOTS,
  TRANSCRIPT_PINS,
  TRANSCRIPT_READ_TICKETS,
  TRANSCRIPT_ROW_DESCRIPTOR_BYTES,
  TRANSCRIPT_SCOPES,
  TRANSCRIPT_TOTAL_BYTES,
  TRANSCRIPT_TOTAL_ROWS,
  TranscriptPagePin,
  TranscriptPageStore,
  TranscriptReadTicket,
  TranscriptScopeHandle,
  type TranscriptPage,
  type TranscriptPageInput,
  type TranscriptScopeIdentity,
  type TranscriptWriteResult,
} from "../transcript-page-store";

const personal = { accountId: "account-a", organizationId: null, placement: "local", workspaceId: "/Users/me/app",
  chatId: "chat-1", source: "native", rootId: "root-1", authority: "authority-1" } as const;
const orgLocal = { ...personal, organizationId: "org-1" } as const;
const cloud = { ...personal, organizationId: "org-1", placement: "cloud", workspaceId: "cloud://org-1/ws-1" } as const;
const row = (id: string, bytes = 100, revision = "r1") => ({ id, revision, bytes, value: { id, text: `row ${id}` } });
const rows = (prefix: string, count: number, bytes = 100) => Array.from({ length: count }, (_, i) => row(`${prefix}-${i}`, bytes));
type Row = ReturnType<typeof row>;
const complete = (list: Row[]) => ({ coverage: "complete" as const, rows: list });
const unknown = (list: Row[]) => ({ coverage: "unknown" as const, rows: list });
const emptyStats = { scopes: 0, chats: 0, pages: 0, rows: 0, bytes: 0, tickets: 0, pins: 0 };
const invalid = (fields: Record<string, unknown>) => ({ ...personal, ...fields }) as unknown as TranscriptScopeIdentity;
const weightOf = (key: string, list: Row[]) => list.reduce(
  (sum, item) => sum + item.bytes + TRANSCRIPT_ROW_DESCRIPTOR_BYTES + 2 * (item.id.length + item.revision.length),
  TRANSCRIPT_PAGE_DESCRIPTOR_BYTES + 2 * key.length,
);

let store: TranscriptPageStore<unknown>;

beforeEach(() => {
  store = new TranscriptPageStore<unknown>();
  store.setAccount("account-a");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const open = (identity: TranscriptScopeIdentity): TranscriptScopeHandle => {
  const handle = store.openScope(identity);
  if (!handle) throw new Error("expected an open scope");
  return handle;
};
const readAt = (scope: TranscriptScopeHandle, key: string): TranscriptReadTicket => {
  const ticket = store.beginRead(scope, key);
  if (!ticket) throw new Error("expected a read ticket");
  return ticket;
};
const commit = (scope: TranscriptScopeHandle, key: string, input: TranscriptPageInput<unknown>) =>
  store.commitRead(readAt(scope, key), input);
const pageOf = (result: TranscriptWriteResult<unknown>): TranscriptPage<unknown> => {
  if (result.status !== "stored" && result.status !== "unchanged") throw new Error(`expected a page, got ${result.status}`);
  return result.page;
};
const pinOf = (pin: TranscriptPagePin | null): TranscriptPagePin => {
  if (!pin) throw new Error("expected a pin");
  return pin;
};

describe("transcript page store", () => {
  describe("identity and isolation", () => {
    it("01 keeps local, organization-local and cloud handles distinct for one chat", () => {
      const local = open(personal);
      const orgScope = open(orgLocal);
      const cloudScope = open({ ...personal, organizationId: "org-1", placement: "cloud" });
      expect(new Set([local, orgScope, cloudScope]).size).toBe(3);
      commit(local, "a", complete(rows("l", 2)));
      expect(store.peek(orgScope, "a")).toBeUndefined();
      expect(store.peek(cloudScope, "a")).toBeUndefined();
      commit(orgScope, "a", complete(rows("o", 3)));
      expect(store.usage(local)).toEqual({ pages: 1, rows: 2, bytes: weightOf("a", rows("l", 2)) });
      expect(store.usage(orgScope)?.rows).toBe(3);
      expect(store.usage(cloudScope)).toEqual({ pages: 0, rows: 0, bytes: 0 });
    });

    it("02 opens only the Local owner's identity while signed out", () => {
      store = new TranscriptPageStore<unknown>();
      expect(store.openScope({ ...personal, accountId: null })).not.toBeNull();
      expect(store.openScope({ ...orgLocal, accountId: null })).toBeNull();
      expect(store.openScope({ ...cloud, accountId: null })).toBeNull();
    });

    it("03 rejects cloud on the Local owner and identities of another account", () => {
      expect(store.openScope({ ...cloud, organizationId: null })).toBeNull();
      const home = open(personal);
      expect(store.openScope({ ...personal, accountId: "account-b" })).toBeNull();
      expect(store.findScope({ ...personal, accountId: "account-b" })).toBeNull();
      expect(store.findScope(personal)).toBe(home);
    });

    it("04 separates source, root and authority but shares one chat's usage", () => {
      const native = open(personal);
      const cpV2 = open({ ...personal, source: "cp-v2" });
      const otherRoot = open({ ...personal, rootId: "root-2" });
      const otherAuthority = open({ ...personal, authority: "authority-2" });
      expect(new Set([native, cpV2, otherRoot, otherAuthority]).size).toBe(4);
      const committed: [TranscriptScopeHandle, string, Row[]][] = [
        [native, "n-0", rows("n0", 200)],
        [native, "n-1", rows("n1", 200)],
        [native, "n-2", rows("n2", 200)],
        [cpV2, "c-0", rows("c0", 200)],
        [cpV2, "c-1", rows("c1", 200)],
      ];
      for (const [scope, key, list] of committed) commit(scope, key, complete(list));
      const bytes = committed.reduce((sum, [, key, list]) => sum + weightOf(key, list), 0);
      for (const scope of [native, cpV2, otherRoot, otherAuthority]) {
        expect(store.usage(scope)).toEqual({ pages: 5, rows: 1000, bytes });
      }
    });

    it("05 returns null for invalid identities without allocating a scope", () => {
      const before = store.stats().scopes;
      expect(store.openScope({ ...personal, chatId: "" })).toBeNull();
      expect(store.openScope({ ...personal, chatId: "c".repeat(257) })).toBeNull();
      expect(store.openScope(invalid({ placement: "remote" }))).toBeNull();
      expect(store.openScope({ ...personal, workspaceId: "w".repeat(4097) })).toBeNull();
      expect(store.openScope({ ...personal, source: "s".repeat(65) })).toBeNull();
      expect(store.stats().scopes).toBe(before);
    });

    it("06 returns the open handle for an equal identity and findScope never changes recency", () => {
      const first = open({ ...personal, chatId: "chat-0" });
      expect(open({ ...personal, chatId: "chat-0" })).toBe(first);
      const others = Array.from({ length: TRANSCRIPT_SCOPES - 1 }, (_, i) => open({ ...personal, chatId: `chat-${i + 1}` }));
      expect(store.findScope({ ...personal, chatId: "chat-0" })).toBe(first);
      const newest = open({ ...personal, chatId: `chat-${TRANSCRIPT_SCOPES}` });
      expect(store.isOpen(first)).toBe(false);
      expect(others.every(scope => store.isOpen(scope))).toBe(true);
      expect(store.isOpen(newest)).toBe(true);
    });

    it("07 freezes its identity copy so caller mutation changes nothing", () => {
      const identity = { ...personal, chatId: "chat-7" };
      const handle = open(identity);
      identity.chatId = "chat-8";
      expect(handle.identity.chatId).toBe("chat-7");
      expect(Object.isFrozen(handle.identity)).toBe(true);
      expect(store.findScope({ ...personal, chatId: "chat-7" })).toBe(handle);
      expect(store.findScope(identity)).toBeNull();
    });
  });

  describe("account and owner switching", () => {
    it("08 retires scopes on account switches and never revives an old handle", () => {
      const first = open(cloud);
      commit(first, "a", complete(rows("a", 2)));
      const pending = readAt(first, "b");
      const version = store.version;
      store.setAccount("account-b");
      expect(store.isOpen(first)).toBe(false);
      expect(store.peek(first, "a")).toBeUndefined();
      expect(store.stats()).toEqual(emptyStats);
      expect(store.version).toBe(version + 1);
      store.setAccount("account-a");
      expect(store.version).toBe(version + 1);
      const second = open(cloud);
      expect(second).not.toBe(first);
      expect(store.isOpen(first)).toBe(false);
      expect(store.peek(second, "a")).toBeUndefined();
      expect(store.commitRead(pending, complete(rows("late", 1)))).toEqual({ status: "stale" });
      expect(store.usage(second)).toEqual({ pages: 0, rows: 0, bytes: 0 });
      expect(store.version).toBe(version + 1);
    });

    it("09 keeps one handle and one page across owner A to B to A in one account", () => {
      const home = open(cloud);
      const page = pageOf(commit(home, "p", complete(rows("p", 2))));
      const otherOrg = open({ ...cloud, organizationId: "org-2", workspaceId: "cloud://org-2/ws-1" });
      commit(otherOrg, "p", complete(rows("q", 2)));
      expect(open(cloud)).toBe(home);
      expect(store.peek(home, "p")).toBe(page);
    });

    it("10 treats setAccount of the current account as a no-op and rejects invalid accounts", () => {
      const local = open(personal);
      const cloudScope = open(cloud);
      const listener = vi.fn();
      store.subscribe(listener);
      const version = store.version;
      store.setAccount("account-a");
      expect(store.isOpen(local)).toBe(true);
      expect(store.isOpen(cloudScope)).toBe(true);
      expect(store.version).toBe(version);
      expect(listener).not.toHaveBeenCalled();
      for (const value of ["", "a".repeat(257), 42, undefined]) {
        const call = () => store.setAccount(value as unknown as string);
        expect(call).toThrow(TypeError);
        expect(call).toThrow("Invalid transcript account");
      }
    });
  });

  describe("read tickets", () => {
    it("11 returns one ticket per scope and page and a new ticket after commit", () => {
      const scope = open(personal);
      const ticket = readAt(scope, "a");
      expect(store.beginRead(scope, "a")).toBe(ticket);
      expect(readAt(scope, "b")).not.toBe(ticket);
      commit(scope, "a", complete(rows("a", 1)));
      expect(readAt(scope, "a")).not.toBe(ticket);
    });

    it("12 lets only the newest read ticket finalize after a failed read", () => {
      const scope = open(personal);
      const first = readAt(scope, "a");
      expect(store.failRead(first)).toBe(true);
      const second = readAt(scope, "a");
      expect(second).not.toBe(first);
      expect(store.failRead(first)).toBe(false);
      expect(store.commitRead(first, complete(rows("old", 1)))).toEqual({ status: "stale" });
      expect(store.isPending(second)).toBe(true);
      expect(store.commitRead(second, complete(rows("new", 1))).status).toBe("stored");
    });

    it("13 lets a live publication win over an older read", () => {
      const scope = open(personal);
      const older = readAt(scope, "tail");
      const live = pageOf(store.publish(scope, "tail", complete(rows("live", 1))));
      expect(store.commitRead(older, complete(rows("older", 1)))).toEqual({ status: "stale" });
      expect(store.peek(scope, "tail")).toBe(live);
      const reader = readAt(scope, "tail");
      expect(store.publish(scope, "tail", unknown([])).status).toBe("unchanged");
      expect(store.commitRead(reader, complete(rows("late", 1)))).toEqual({ status: "stale" });
    });

    it("14 keeps a retired scope's read stale after the identity reopens", () => {
      const old = open(personal);
      const first = readAt(old, "a");
      expect(store.retireScope(old)).toBe(true);
      expect(store.commitRead(first, complete(rows("x", 1)))).toEqual({ status: "stale" });
      expect(store.failRead(first)).toBe(false);
      const reopened = open(personal);
      expect(reopened).not.toBe(old);
      const third = readAt(reopened, "a");
      expect(third).not.toBe(first);
      expect(store.commitRead(first, complete(rows("x", 1)))).toEqual({ status: "stale" });
      expect(store.peek(reopened, "a")).toBeUndefined();
      expect(store.commitRead(third, complete(rows("y", 1))).status).toBe("stored");
    });

    it("15 evicts the least recently used scope and retires its pending tickets", () => {
      const first = open({ ...personal, chatId: "chat-0" });
      const ticket = readAt(first, "k");
      for (let i = 1; i < TRANSCRIPT_SCOPES; i++) open({ ...personal, chatId: `chat-${i}` });
      open({ ...personal, chatId: `chat-${TRANSCRIPT_SCOPES}` });
      expect(store.isPending(ticket)).toBe(false);
      expect(store.commitRead(ticket, complete(rows("k", 1)))).toEqual({ status: "stale" });
    });

    it("16 bounds pending read tickets", () => {
      const scope = open(personal);
      const tickets = Array.from({ length: TRANSCRIPT_READ_TICKETS }, (_, i) => readAt(scope, `k-${i}`));
      expect(store.beginRead(scope, `k-${TRANSCRIPT_READ_TICKETS}`)).toBeNull();
      expect(store.beginRead(scope, "k-0")).toBe(tickets[0]);
      expect(store.failRead(tickets[0])).toBe(true);
      expect(store.beginRead(scope, `k-${TRANSCRIPT_READ_TICKETS}`)).not.toBeNull();
    });

    it("17 treats a retired or constructed handle as closed", () => {
      const old = open(cloud);
      store.retireScope(old);
      const closed = (scope: TranscriptScopeHandle) => {
        expect(store.beginRead(scope, "k")).toBeNull();
        expect(store.peek(scope, "k")).toBeUndefined();
        expect(store.publish(scope, "k", complete(rows("k", 1)))).toEqual({ status: "stale" });
        expect(store.pin(scope, "k")).toBeNull();
        expect(store.usage(scope)).toBeNull();
        expect(store.isOpen(scope)).toBe(false);
        expect(store.retireScope(scope)).toBe(false);
      };
      closed(old);
      const constructed = new TranscriptScopeHandle(cloud);
      closed(constructed);
      expect(store.commitRead(new TranscriptReadTicket(constructed, "k"), complete(rows("k", 1)))).toEqual({ status: "stale" });
      expect(store.unpin(new TranscriptPagePin(constructed, "k"))).toBe(false);
      const reopened = open(cloud);
      expect(store.isOpen(constructed)).toBe(false);
      expect(store.isOpen(reopened)).toBe(true);
    });

    it("18 ends the ticket on invalid and over_budget commits and keeps the resident page", () => {
      const scope = open(personal);
      const resident = pageOf(commit(scope, "k", complete(rows("k", 2))));
      const before = store.stats();
      const invalidTicket = readAt(scope, "k");
      expect(store.commitRead(invalidTicket, complete([row("dup"), row("dup")])).status).toBe("invalid");
      expect(store.isPending(invalidTicket)).toBe(false);
      const heavyTicket = readAt(scope, "k");
      expect(store.commitRead(heavyTicket, complete([row("heavy", TRANSCRIPT_CHAT_BYTES)])).status).toBe("over_budget");
      expect(store.isPending(heavyTicket)).toBe(false);
      expect(store.peek(scope, "k")).toBe(resident);
      expect(store.stats()).toEqual(before);
    });
  });

  describe("coverage", () => {
    it("19 keeps unknown and complete empty pages distinct and absent pages unknown", () => {
      const scope = open(personal);
      expect(store.peek(scope, "a")).toBeUndefined();
      const unknownPage = pageOf(commit(scope, "a", unknown([])));
      expect(unknownPage.coverage).toBe("unknown");
      expect(unknownPage.rows).toEqual([]);
      const completePage = pageOf(commit(scope, "b", complete([])));
      expect(completePage.coverage).toBe("complete");
      expect(completePage.rows).toEqual([]);
      expect(completePage).not.toBe(unknownPage);
      expect(store.peek(scope, "c")).toBeUndefined();
    });

    it("20 keeps positive unknown rows through unknown empty revalidation", () => {
      const scope = open(personal);
      const positive = pageOf(commit(scope, "a", unknown([row("x"), row("y")])));
      const revalidated = commit(scope, "a", unknown([]));
      expect(revalidated.status).toBe("unchanged");
      expect(pageOf(revalidated)).toBe(positive);
      const published = store.publish(scope, "a", unknown([]));
      expect(published.status).toBe("unchanged");
      expect(pageOf(published)).toBe(positive);
      const confirmedResult = commit(scope, "a", complete([]));
      expect(confirmedResult.status).toBe("stored");
      const confirmed = pageOf(confirmedResult);
      expect(confirmed.rows).toEqual([]);
      expect(confirmed.coverage).toBe("complete");
    });

    it("21 keeps a confirmed empty page through unknown empty revalidation", () => {
      const scope = open(personal);
      const confirmed = pageOf(commit(scope, "a", complete([])));
      const revalidated = commit(scope, "a", unknown([]));
      expect(revalidated.status).toBe("unchanged");
      expect(pageOf(revalidated)).toBe(confirmed);
    });

    it("22 lets unknown rows replace a complete page and reuses the unchanged row object", () => {
      const scope = open(personal);
      const x = row("x");
      const y = row("y");
      const before = pageOf(commit(scope, "a", complete([x, y])));
      const result = commit(scope, "a", unknown([x]));
      expect(result.status).toBe("stored");
      const page = pageOf(result);
      expect(page.coverage).toBe("unknown");
      expect(page.rows).toHaveLength(1);
      expect(page.rows[0]).toBe(before.rows[0]);
    });
  });

  describe("stable references", () => {
    it("23 keeps the page for equal rows with new input objects and the same coverage", () => {
      const scope = open(personal);
      const first = pageOf(commit(scope, "a", complete(rows("r", 3))));
      const listener = vi.fn();
      store.subscribe(listener);
      const version = store.version;
      const again = commit(scope, "a", complete(rows("r", 3)));
      expect(again.status).toBe("unchanged");
      expect(pageOf(again)).toBe(first);
      expect(store.version).toBe(version);
      expect(listener).not.toHaveBeenCalled();
    });

    it("24 creates only the changed row and a new page for one changed revision", () => {
      const scope = open(personal);
      const sibling = pageOf(commit(scope, "sibling", complete(rows("s", 2))));
      const first = pageOf(commit(scope, "a", complete(rows("a", 3))));
      const changed = pageOf(commit(scope, "a", complete([row("a-0"), row("a-1", 100, "r2"), row("a-2")])));
      expect(changed).not.toBe(first);
      expect(changed.rows[0]).toBe(first.rows[0]);
      expect(changed.rows[1]).not.toBe(first.rows[1]);
      expect(changed.rows[1].revision).toBe("r2");
      expect(changed.rows[2]).toBe(first.rows[2]);
      expect(store.peek(scope, "sibling")).toBe(sibling);
    });

    it("25 reuses row objects when rows move between pages in one scope", () => {
      const scope = open(personal);
      const tail = pageOf(commit(scope, "tail", complete(rows("t", 200))));
      const older = pageOf(commit(scope, "older", complete(rows("t", 100))));
      for (let i = 0; i < 100; i++) expect(older.rows[i]).toBe(tail.rows[i]);
    });

    it("26 never shares row objects across scopes", () => {
      const native = open(personal);
      const cpV2 = open({ ...personal, source: "cp-v2" });
      const first = pageOf(commit(native, "a", complete(rows("r", 2))));
      const second = pageOf(commit(cpV2, "a", complete(rows("r", 2))));
      expect(second.rows[0]).not.toBe(first.rows[0]);
      expect(second.rows[1]).not.toBe(first.rows[1]);
    });

    it("27 creates a new row object when bytes change for the same id and revision", () => {
      const scope = open(personal);
      const first = pageOf(commit(scope, "a", complete([row("x", 100)])));
      const second = pageOf(commit(scope, "a", complete([row("x", 200)])));
      expect(second.rows[0]).not.toBe(first.rows[0]);
      expect(second.rows[0].bytes).toBe(200);
    });

    it("28 freezes the page, its rows and each row, and keeps value by reference", () => {
      const scope = open(personal);
      const input = row("x");
      const page = pageOf(commit(scope, "a", complete([input])));
      expect(Object.isFrozen(page)).toBe(true);
      expect(Object.isFrozen(page.rows)).toBe(true);
      expect(Object.isFrozen(page.rows[0])).toBe(true);
      expect(page.rows[0].value).toBe(input.value);
    });

    it("29 never reads, copies or freezes row values", () => {
      const scope = open(personal);
      const hostile = new Proxy({}, {
        get() { throw new Error("touched"); },
        ownKeys() { throw new Error("touched"); },
      });
      const ticket = readAt(scope, "hostile");
      expect(() => store.commitRead(ticket, { coverage: "complete", rows: [{ id: "h", revision: "r1", bytes: 100, value: hostile }] })).not.toThrow();
      expect(() => store.peek(scope, "hostile")).not.toThrow();
      for (let i = 0; i < 5; i++) commit(scope, `f-${i}`, complete(rows(`f${i}`, 200)));
      expect(store.peek(scope, "hostile")).toBeUndefined();
    });
  });

  describe("bounds and atomic refusal", () => {
    it("30 accepts exactly the page row limit", () => {
      const scope = open(personal);
      expect(commit(scope, "a", complete(rows("a", TRANSCRIPT_PAGE_ROWS))).status).toBe("stored");
      const before = store.stats();
      expect(commit(scope, "b", complete(rows("b", TRANSCRIPT_PAGE_ROWS + 1))).status).toBe("invalid");
      expect(store.stats()).toEqual(before);
    });

    it("31 refuses malformed page input and keeps the resident page and its siblings", () => {
      const scope = open(personal);
      const resident = pageOf(commit(scope, "k", complete(rows("k", 2))));
      const sibling = pageOf(commit(scope, "s", complete(rows("s", 2))));
      const before = store.stats();
      const badRow = (fields: Record<string, unknown>) => ({ ...row("b"), ...fields });
      const malformed: unknown[] = [
        { coverage: "complete", rows: [row("d"), row("d")] },
        { coverage: "complete", rows: [badRow({ bytes: -1 })] },
        { coverage: "complete", rows: [badRow({ bytes: 1.5 })] },
        { coverage: "complete", rows: [badRow({ bytes: Number.NaN })] },
        { coverage: "complete", rows: [badRow({ bytes: Number.MAX_SAFE_INTEGER + 1 })] },
        { coverage: "complete", rows: [badRow({ bytes: "100" })] },
        { coverage: "complete", rows: [badRow({ id: "" })] },
        { coverage: "complete", rows: [badRow({ id: "i".repeat(257) })] },
        { coverage: "complete", rows: [badRow({ revision: "" })] },
        { coverage: "partial", rows: [row("p")] },
        { coverage: "complete", rows: { length: 0 } },
      ];
      for (const input of malformed) {
        expect(store.commitRead(readAt(scope, "k"), input as TranscriptPageInput<unknown>).status).toBe("invalid");
      }
      expect(store.publish(scope, "", complete([row("x")])).status).toBe("invalid");
      expect(store.publish(scope, "k".repeat(513), complete([row("x")])).status).toBe("invalid");
      expect(store.peek(scope, "k")).toBe(resident);
      expect(store.peek(scope, "s")).toBe(sibling);
      expect(store.stats()).toEqual(before);
    });

    it("32 weighs a page as its rows plus the descriptor weight", () => {
      const scope = open(personal);
      const list = [row("a-0", 10, "r1"), row("a-1", 20, "rev-2")];
      const page = pageOf(commit(scope, "key-1", complete(list)));
      expect(page.bytes).toBe(weightOf("key-1", list));
      expect(page.bytes).toBe(450);
    });

    it("33 evicts only the least recently used page of an over-budget chat", () => {
      const home = open(personal);
      const other = open({ ...personal, chatId: "chat-2" });
      const otherPage = pageOf(commit(other, "only", complete(rows("o", 200))));
      for (let i = 0; i < 5; i++) commit(home, `p-${i}`, complete(rows(`c${i}`, 200)));
      expect(store.usage(home)?.rows).toBe(TRANSCRIPT_CHAT_ROWS);
      expect(commit(home, "p-5", complete(rows("c5", 200))).status).toBe("stored");
      expect(store.peek(home, "p-0")).toBeUndefined();
      for (let i = 1; i <= 5; i++) expect(store.peek(home, `p-${i}`)).toBeDefined();
      expect(store.usage(home)?.rows).toBe(TRANSCRIPT_CHAT_ROWS);
      expect(store.peek(other, "only")).toBe(otherPage);
    });

    it("34 keeps a chat under its byte budget by evicting its least recently used page", () => {
      const scope = open(personal);
      const big = 6 * 1024 * 1024;
      commit(scope, "b-0", complete([row("b-0", big)]));
      commit(scope, "b-1", complete([row("b-1", big)]));
      expect(commit(scope, "b-2", complete([row("b-2", big)])).status).toBe("stored");
      expect(store.peek(scope, "b-0")).toBeUndefined();
      expect(store.usage(scope)?.bytes).toBeLessThanOrEqual(TRANSCRIPT_CHAT_BYTES);
    });

    it("35 refuses a page heavier than its chat budget without evicting siblings", () => {
      const scope = open(personal);
      const sibling = pageOf(commit(scope, "s", complete(rows("s", 2))));
      const before = store.stats();
      expect(commit(scope, "heavy", complete([row("heavy", TRANSCRIPT_CHAT_BYTES)])).status).toBe("over_budget");
      expect(store.peek(scope, "s")).toBe(sibling);
      expect(store.stats()).toEqual(before);
    });

    it("36 holds the global row budget by evicting the least recently used page", () => {
      const chats = Array.from({ length: 5 }, (_, c) => open({ ...personal, chatId: `chat-${c}` }));
      chats.forEach((chat, c) => {
        for (let p = 0; p < 4; p++) commit(chat, `p-${p}`, complete(rows(`c${c}p${p}`, 200)));
      });
      expect(store.stats().rows).toBe(TRANSCRIPT_TOTAL_ROWS);
      const sixth = open({ ...personal, chatId: "chat-5" });
      expect(commit(sixth, "p-0", complete(rows("c5p0", 200))).status).toBe("stored");
      expect(store.peek(chats[0], "p-0")).toBeUndefined();
      expect(store.peek(chats[0], "p-1")).toBeDefined();
      expect(store.stats().rows).toBeLessThanOrEqual(TRANSCRIPT_TOTAL_ROWS);
    });

    it("37 keeps total bytes under the global byte budget", () => {
      const heavy = 13 * 1024 * 1024;
      const scopes = Array.from({ length: 5 }, (_, c) => open({ ...personal, chatId: `chat-${c}` }));
      scopes.forEach((scope, c) => commit(scope, "heavy", complete([row(`h-${c}`, heavy)])));
      expect(store.peek(scopes[0], "heavy")).toBeUndefined();
      expect(store.stats().pages).toBe(4);
      expect(store.stats().bytes).toBeLessThanOrEqual(TRANSCRIPT_TOTAL_BYTES);
    });

    it("38 holds the page slot budget by evicting the least recently used page", () => {
      const scopes = Array.from({ length: 13 }, (_, s) => open({ ...personal, chatId: `chat-${s}` }));
      for (let i = 0; i < TRANSCRIPT_PAGE_SLOTS; i++) commit(scopes[i % 13], `k-${i}`, unknown([]));
      expect(store.stats().pages).toBe(TRANSCRIPT_PAGE_SLOTS);
      expect(commit(scopes[TRANSCRIPT_PAGE_SLOTS % 13], `k-${TRANSCRIPT_PAGE_SLOTS}`, unknown([])).status).toBe("stored");
      expect(store.peek(scopes[0], "k-0")).toBeUndefined();
      expect(store.stats().pages).toBe(TRANSCRIPT_PAGE_SLOTS);
    });

    it("39 counts a peek as recency for the next eviction", () => {
      const scope = open(personal);
      for (let i = 0; i < TRANSCRIPT_PAGE_SLOTS; i++) commit(scope, `k-${i}`, unknown([]));
      expect(store.peek(scope, "k-0")).toBeDefined();
      commit(scope, `k-${TRANSCRIPT_PAGE_SLOTS}`, unknown([]));
      expect(store.peek(scope, "k-0")).toBeDefined();
      expect(store.peek(scope, "k-1")).toBeUndefined();
    });

    it("40 never raises a budget for pinned pages", () => {
      const chat = open(personal);
      const pins = [0, 1, 2, 3, 4].map(i => {
        commit(chat, `p-${i}`, complete(rows(`c${i}`, 200)));
        return pinOf(store.pin(chat, `p-${i}`));
      });
      expect(commit(chat, "p-5", complete(rows("c5", 200))).status).toBe("over_budget");
      for (let i = 0; i < 5; i++) expect(store.peek(chat, `p-${i}`)).toBeDefined();
      expect(store.unpin(pins[0])).toBe(true);
      expect(commit(chat, "p-5", complete(rows("c5", 200))).status).toBe("stored");
      expect(store.peek(chat, "p-0")).toBeUndefined();
      for (let i = 1; i < 5; i++) expect(store.peek(chat, `p-${i}`)).toBeDefined();
    });

    it("41 lets pinned pages block global eviction", () => {
      const chats = Array.from({ length: 5 }, (_, c) => open({ ...personal, chatId: `chat-${c}` }));
      chats.forEach((chat, c) => {
        for (let p = 0; p < 4; p++) {
          commit(chat, `p-${p}`, complete(rows(`c${c}p${p}`, 200)));
          pinOf(store.pin(chat, `p-${p}`));
        }
      });
      expect(store.stats().rows).toBe(TRANSCRIPT_TOTAL_ROWS);
      const sixth = open({ ...personal, chatId: "chat-5" });
      expect(commit(sixth, "p-0", complete(rows("c5p0", 200))).status).toBe("over_budget");
      expect(store.stats().rows).toBe(TRANSCRIPT_TOTAL_ROWS);
    });

    it("42 refuses atomically when the evictable rows cannot make room", () => {
      const chat = open(personal);
      const pins = [200, 200, 200, 200, 150].map((size, i) => {
        commit(chat, `pinned-${i}`, complete(rows(`pinned${i}`, size)));
        return pinOf(store.pin(chat, `pinned-${i}`));
      });
      const loose = pageOf(commit(chat, "loose", complete(rows("loose", 50))));
      expect(store.usage(chat)?.rows).toBe(TRANSCRIPT_CHAT_ROWS);
      const before = store.stats();
      expect(commit(chat, "new", complete(rows("new", 200))).status).toBe("over_budget");
      expect(store.peek(chat, "loose")).toBe(loose);
      expect(store.stats()).toEqual(before);
      expect(store.unpin(pins[4])).toBe(true);
      expect(commit(chat, "new", complete(rows("new", 200))).status).toBe("stored");
      expect(store.peek(chat, "loose")).toBeUndefined();
      expect(store.peek(chat, "pinned-4")).toBeUndefined();
      for (let i = 0; i < 4; i++) expect(store.peek(chat, `pinned-${i}`)).toBeDefined();
      expect(store.usage(chat)?.rows).toBe(TRANSCRIPT_CHAT_ROWS);
    });

    it("43 frees a replaced page's weight before admission", () => {
      const chat = open(personal);
      const keys = ["a", "b", "c", "d", "e"];
      const pages = keys.map(key => pageOf(commit(chat, key, complete(rows(key, 200)))));
      expect(store.usage(chat)?.rows).toBe(TRANSCRIPT_CHAT_ROWS);
      expect(commit(chat, "a", complete(rows("a2", 200))).status).toBe("stored");
      for (let i = 1; i < keys.length; i++) expect(store.peek(chat, keys[i])).toBe(pages[i]);
      expect(store.usage(chat)?.rows).toBe(TRANSCRIPT_CHAT_ROWS);
    });

    it("44 keeps a pinned key resident through replacement and eviction", () => {
      const chat = open(personal);
      commit(chat, "k", complete(rows("k", 200)));
      const pin = pinOf(store.pin(chat, "k"));
      expect(commit(chat, "k", complete(rows("k2", 200))).status).toBe("stored");
      for (let i = 0; i < 5; i++) commit(chat, `f-${i}`, complete(rows(`f${i}`, 200)));
      expect(store.peek(chat, "k")).toBeDefined();
      expect(store.unpin(pin)).toBe(true);
    });
  });

  describe("pins", () => {
    it("45 refuses pins for absent or retired pages and caps pins", () => {
      const scope = open(personal);
      expect(store.pin(scope, "absent")).toBeNull();
      commit(scope, "k", complete(rows("k", 1)));
      const first = pinOf(store.pin(scope, "k"));
      expect(store.unpin(first)).toBe(true);
      expect(store.unpin(first)).toBe(false);
      const held = Array.from({ length: TRANSCRIPT_PINS }, () => store.pin(scope, "k"));
      expect(held.every(pin => pin !== null)).toBe(true);
      expect(store.pin(scope, "k")).toBeNull();
      expect(store.stats().pins).toBe(TRANSCRIPT_PINS);
      store.retireScope(scope);
      expect(store.pin(scope, "k")).toBeNull();
    });

    it("46 releases pins with their scope and never lets an old pin release a new page", () => {
      const old = open(personal);
      commit(old, "k", complete(rows("k", 1)));
      const oldPin = pinOf(store.pin(old, "k"));
      store.retireScope(old);
      expect(store.unpin(oldPin)).toBe(false);
      const reopened = open(personal);
      expect(reopened).not.toBe(old);
      commit(reopened, "k", complete(rows("k", 1)));
      const newPin = pinOf(store.pin(reopened, "k"));
      expect(store.unpin(oldPin)).toBe(false);
      expect(store.stats().pins).toBe(1);
      expect(store.unpin(newPin)).toBe(true);
    });

    it("47 skips pinned scopes when a new scope evicts", () => {
      const scopes = Array.from({ length: TRANSCRIPT_SCOPES }, (_, i) => {
        const scope = open({ ...personal, chatId: `chat-${i}` });
        commit(scope, "p", complete(rows(`s${i}`, 1)));
        return scope;
      });
      pinOf(store.pin(scopes[0], "p"));
      const newest = open({ ...personal, chatId: `chat-${TRANSCRIPT_SCOPES}` });
      expect(store.isOpen(scopes[1])).toBe(false);
      expect(store.isOpen(scopes[0])).toBe(true);
      commit(newest, "p", complete(rows("n", 1)));
      for (const scope of [...scopes.slice(2), newest]) pinOf(store.pin(scope, "p"));
      const before = store.stats();
      expect(store.openScope({ ...personal, chatId: "chat-after" })).toBeNull();
      expect(store.stats()).toEqual(before);
    });
  });

  describe("bounded metadata over long history", () => {
    it("48 keeps metadata bounded over a long sequential history", () => {
      const scope = open(personal);
      for (let i = 0; i < 2000; i++) {
        expect(store.commitRead(readAt(scope, `page-${i}`), complete(rows(`p${i}`, 200))).status).toBe("stored");
        const stats = store.stats();
        expect(stats.rows).toBeLessThanOrEqual(TRANSCRIPT_CHAT_ROWS);
        expect(stats.pages).toBeLessThanOrEqual(5);
        expect(stats.tickets).toBe(0);
      }
      const resident = [1995, 1996, 1997, 1998, 1999];
      expect(store.stats()).toEqual({
        scopes: 1,
        chats: 1,
        pages: 5,
        rows: 1000,
        tickets: 0,
        pins: 0,
        bytes: resident.reduce((sum, i) => sum + weightOf(`page-${i}`, rows(`p${i}`, 200)), 0),
      });
    });

    it("49 keeps scopes, chats and pages bounded across many chats over time", () => {
      for (let i = 0; i < 200; i++) commit(open({ ...personal, chatId: `chat-${i}` }), "page", unknown([]));
      const stats = store.stats();
      expect(stats.scopes).toBeLessThanOrEqual(TRANSCRIPT_SCOPES);
      expect(stats.chats).toBeLessThanOrEqual(TRANSCRIPT_SCOPES);
      expect(stats.pages).toBeLessThanOrEqual(TRANSCRIPT_SCOPES);
    });

    it("50 returns every metric to zero when all open scopes retire", () => {
      const scopes = Array.from({ length: 3 }, (_, i) => open({ ...personal, chatId: `chat-${i}` }));
      scopes.forEach((scope, i) => {
        commit(scope, "a", complete(rows(`c${i}`, 2)));
        readAt(scope, "b");
        pinOf(store.pin(scope, "a"));
      });
      for (const scope of scopes) expect(store.retireScope(scope)).toBe(true);
      expect(store.stats()).toEqual(emptyStats);
    });
  });

  describe("notifications and inertness", () => {
    it("51 notifies once for each change to peek or isOpen and never for the rest", () => {
      const listener = vi.fn();
      const unsubscribe = store.subscribe(listener);
      const quiet = <R>(action: () => R): R => {
        const version = store.version;
        const calls = listener.mock.calls.length;
        const result = action();
        expect(store.version).toBe(version);
        expect(listener.mock.calls.length).toBe(calls);
        return result;
      };
      const notified = <R>(action: () => R): R => {
        const version = store.version;
        const calls = listener.mock.calls.length;
        const result = action();
        expect(store.version).toBe(version + 1);
        expect(listener.mock.calls.length).toBe(calls + 1);
        return result;
      };
      const scope = quiet(() => open(personal));
      quiet(() => store.openScope(personal));
      quiet(() => store.findScope(personal));
      quiet(() => store.peek(scope, "a"));
      const pending = quiet(() => readAt(scope, "a"));
      quiet(() => store.beginRead(scope, "a"));
      expect(quiet(() => store.failRead(pending))).toBe(true);
      expect(quiet(() => store.commitRead(pending, complete(rows("x", 1))))).toEqual({ status: "stale" });
      expect(quiet(() => store.publish(scope, "", complete(rows("x", 1)))).status).toBe("invalid");
      expect(quiet(() => commit(scope, "a", { coverage: "partial", rows: [] } as unknown as TranscriptPageInput<unknown>)).status).toBe("invalid");
      expect(notified(() => commit(scope, "a", complete(rows("a", 200)))).status).toBe("stored");
      expect(quiet(() => commit(scope, "a", complete(rows("a", 200)))).status).toBe("unchanged");
      expect(quiet(() => commit(scope, "a", unknown([]))).status).toBe("unchanged");
      const pin = pinOf(quiet(() => store.pin(scope, "a")));
      expect(quiet(() => store.unpin(pin))).toBe(true);
      expect(quiet(() => commit(scope, "a", complete([row("heavy", TRANSCRIPT_CHAT_BYTES)]))).status).toBe("over_budget");
      for (const key of ["b", "c", "d", "e"]) commit(scope, key, complete(rows(key, 200)));
      expect(notified(() => commit(scope, "f", complete(rows("f", 200)))).status).toBe("stored");
      expect(notified(() => store.retireScope(scope))).toBe(true);
      for (let i = 0; i < TRANSCRIPT_SCOPES; i++) open({ ...personal, chatId: `chat-${i + 2}` });
      expect(notified(() => store.openScope({ ...personal, chatId: "chat-99" }))).not.toBeNull();
      notified(() => store.setAccount("account-b"));
      const after = open({ ...personal, accountId: "account-b" });
      unsubscribe();
      const calls = listener.mock.calls.length;
      store.retireScope(after);
      expect(listener.mock.calls.length).toBe(calls);
    });

    it("52 keeps notifying later listeners after one listener throws", () => {
      const error = new Error("listener failed");
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const later = vi.fn();
      store.subscribe(() => {
        throw error;
      });
      store.subscribe(later);
      const scope = open(personal);
      expect(store.retireScope(scope)).toBe(true);
      expect(later).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledWith("Transcript page store listener failed", error);
      consoleError.mockRestore();
    });

    it("53 schedules no timers", () => {
      vi.useFakeTimers();
      try {
        const scope = open(personal);
        commit(scope, "a", complete(rows("a", 200)));
        pinOf(store.pin(scope, "a"));
        for (const key of ["b", "c", "d", "e", "f"]) commit(scope, key, complete(rows(key, 200)));
        store.publish(scope, "z", unknown([]));
        expect(store.peek(scope, "b")).toBeUndefined();
        for (let i = 0; i < TRANSCRIPT_SCOPES; i++) open({ ...personal, chatId: `chat-${i + 2}` });
        expect(store.retireScope(scope)).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
