import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import * as shared from "@zeros/protocol/agent-messages";
// The control plane ships independently; compare its mirror against Local's real FTS index.
import * as mirror from "../../../../../control-plane/src/cloud/message-search";
import { closeZerosDb, setZerosDbPathForTesting } from "../index";
import { queueStreamingChatMessages, searchMessages, upsertChatMessagesBulk } from "../messages";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => shared.MessageSearchDatabase;
};
const roots: string[] = [];
afterEach(() => {
  closeZerosDb(); setZerosDbPathForTesting(null);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const payloads = [
  { text: "The relay-core reducer forwards opaque ciphertext. Café." },
  { text: "relay without a core" }, { title: "Read relay/server.ts" },
  { text: "literal OR expression" }, { text: "", title: "ignored title" },
  { text: "ciphertext ciphertext ciphertext" }, { text: false, title: "fallback title" },
  null, ["array"], "primitive",
].map(value => JSON.stringify(value));

it.each(["relay", "relay-core", "core relay", "cafe", "ciphertext", '"ciphertext"',
  "OR", "relay OR core", "crypt", "%_", "ignored", "fallback", "title", "NEAR(relay)"])(
  "keeps both cloud search implementations in parity with Local FTS for %j", query => {
    const root = mkdtempSync(join(tmpdir(), "zeros-search-parity-")); roots.push(root);
    setZerosDbPathForTesting(join(root, "db.sqlite"));
    const rows = payloads.map((payload, id) => ({ msgId: `m${id}`, kind: "text", payload, createdAt: id }));
    upsertChatMessagesBulk("chat", rows);
    const expected = searchMessages(query).map(hit => hit.msgId);
    for (const implementation of [shared, mirror]) {
      const index = new implementation.MessageSearchIndex<string>(new DatabaseSync(":memory:"));
      try {
        for (const row of rows) index.add(row.msgId, row.payload);
        expect(index.search(implementation.messageSearchInput(query, 50))).toEqual(expected);
      } finally { index.close(); }
    }
  },
);

it("keeps Local streaming-search flush behavior after extracting text and query helpers", () => {
  const root = mkdtempSync(join(tmpdir(), "zeros-search-stream-")); roots.push(root);
  setZerosDbPathForTesting(join(root, "db.sqlite"));
  upsertChatMessagesBulk("chat", [{ msgId: "m", kind: "text", payload: '{"text":"old"}', createdAt: 1 }]);
  queueStreamingChatMessages("chat", [{ msgId: "m", kind: "text", payload: '{"text":"new"}', createdAt: 1 }]);
  expect(searchMessages("new").map(hit => hit.msgId)).toEqual(["m"]);
  expect(searchMessages("old")).toEqual([]);
});

describe.each([["worker", shared], ["mirror", mirror]] as const)("%s search bounds", (_name, implementation) => {
  it("keeps malformed legacy payloads unsearchable", () => {
    expect(implementation.searchableMessageText("{invalid json")).toBe("");
  });
  it.each([null, 1, "q".repeat(4097), "x\0y", Array(65).fill("word").join(" ")])("refuses invalid input %j", query => {
    expect(() => implementation.messageSearchInput(query, 50)).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });
  it.each([-1, 0.5, Infinity, "1", null])("refuses invalid limit %j", limit => {
    expect(() => implementation.messageSearchInput("needle", limit)).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });
  it("bounds rows, UTF-8 bytes and the original deadline without returning a partial corpus", () => {
    let now = 1000;
    const index = new implementation.MessageSearchIndex<string>(new DatabaseSync(":memory:"), () => now);
    try {
      index.add("unicode", "é");
      expect(() => index.checkBatch(49_999, 16 * 1024 * 1024 - 2)).not.toThrow();
      expect(() => index.checkBatch(50_000, 0)).toThrow(expect.objectContaining({ code: "SEARCH_LIMIT" }));
      expect(() => index.checkBatch(0, 16 * 1024 * 1024 - 1)).toThrow(expect.objectContaining({ code: "SEARCH_LIMIT" }));
      now += 4999; expect(index.remaining()).toBe(1);
      now++; expect(() => index.search(implementation.messageSearchInput("needle", 50)))
        .toThrow(expect.objectContaining({ code: "SEARCH_LIMIT" }));
    } finally { index.close(); }
  });
  it("bounds serialized result bytes and refuses a single unreturnable hit", () => {
    const hit = { chatId: "chat", msgId: "large", payload: "x".repeat(5 * 1024 * 1024), createdAt: 1 };
    expect(implementation.boundMessageSearchHits([hit, { ...hit, msgId: "next" }])).toEqual([hit]);
    expect(() => implementation.boundMessageSearchHits([{ ...hit, payload: "x".repeat(8 * 1024 * 1024) }]))
      .toThrow(expect.objectContaining({ code: "SEARCH_LIMIT" }));
  });
});
