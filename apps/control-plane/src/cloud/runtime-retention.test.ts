import { Readable } from "node:stream";
import { expect, it, vi } from "vitest";
import { planRuntimeRetention, pruneRuntimes, type StoredObject } from "./runtime-retention.js";

const now = Date.parse("2026-10-27T12:00:00Z"), hour = 60 * 60_000, day = 24 * hour;
const sha = (c: string) => c.repeat(64), source = (c: string) => `${c}${"0".repeat(63)}`;
const archive = (c: string, age: number): StoredObject => ({ key: `cloud-v2/runtime/${sha(c)}.tar.gz`, lastModified: new Date(now - age), size: 300e6 });
const index = (c: string, age: number): StoredObject => ({ key: `cloud-v2/runtime/sources/${source(c)}.json`, lastModified: new Date(now - age), size: 200 });

it("keeps the live pin, the two newest and anything from the last day, and removes the rest with their indices", () => {
  const objects = [archive("1", 10 * day), archive("2", 9 * day), archive("3", 8 * day), archive("4", 2 * day), archive("5", 3 * hour), archive("6", 0),
    ...["1", "2", "3", "4", "5", "6"].map(c => index(c, 5 * day))];
  const targets = new Map(["1", "2", "3", "4", "5", "6"].map(c => [`cloud-v2/runtime/sources/${source(c)}.json`, sha(c)]));
  const plan = planRuntimeRetention(objects, targets, { protect: [sha("1")], now });
  expect(plan.kept.sort()).toEqual([sha("1"), sha("5"), sha("6")]);
  expect(plan.archives).toEqual([archive("4", 0).key, archive("3", 0).key, archive("2", 0).key]);
  expect(plan.indices.sort()).toEqual(["2", "3", "4"].map(c => index(c, 0).key).sort());
  expect(plan.bytes).toBe(3 * 300e6 + 3 * 200);
});

it("never removes what it does not recognise, could not read, or that is younger than a day", () => {
  const objects = [archive("1", 10 * day), archive("2", 9 * day), archive("3", 8 * day), archive("4", 20 * hour),
    { key: "cloud-v2/runtime/notes.txt", lastModified: new Date(now - 30 * day), size: 1 },
    index("7", 10 * day), index("8", 10 * day), index("9", 2 * hour)];
  const targets = new Map<string, string | null>([[index("7", 0).key, null], [index("8", 0).key, sha("e")], [index("9", 0).key, sha("f")]]);
  const plan = planRuntimeRetention(objects, targets, { protect: [], now });
  // Archives 3 and 4 are the newest two (4 is also within a day); 1 and 2 go.
  expect(plan.archives.sort()).toEqual([archive("1", 0).key, archive("2", 0).key].sort());
  // Unreadable (7) and fresh (9) indices stay; the old one naming a missing archive (8) goes.
  expect(plan.indices).toEqual([index("8", 0).key]);
  expect([...plan.archives, ...plan.indices]).not.toContain("cloud-v2/runtime/notes.txt");
});

it("removes nothing when every runtime is protected, among the newest or recent", () => {
  const plan = planRuntimeRetention([archive("1", 30 * day), archive("2", 2 * day), archive("3", 0)], new Map(), { protect: [sha("1")], now });
  expect(plan).toMatchObject({ archives: [], indices: [], bytes: 0 });
});

function store(objects: StoredObject[], indexBodies: Record<string, unknown>, deleteErrors = false) {
  const pages = [objects.slice(0, 3), objects.slice(3)];
  return { send: vi.fn(async (command: any) => {
    const name = command.constructor.name, input = command.input;
    if (name === "ListObjectsV2Command") {
      const page = input.ContinuationToken ? 1 : 0;
      return { Contents: pages[page]!.map(o => ({ Key: o.key, LastModified: o.lastModified, Size: o.size })),
        IsTruncated: page === 0, ...(page === 0 ? { NextContinuationToken: "next" } : {}) };
    }
    if (name === "GetObjectCommand") return { Body: Readable.from([Buffer.from(JSON.stringify(indexBodies[input.Key]))]) };
    if (name === "DeleteObjectsCommand") return deleteErrors ? { Errors: [{ Code: "AccessDenied" }] } : {};
    throw new Error(`unexpected ${name}`);
  }) };
}

it("pages through the store, reads each index and deletes indices before their archives", async () => {
  const objects = [archive("1", 10 * day), archive("2", 9 * day), archive("3", 2 * day), archive("4", 0), index("1", 9 * day), index("2", 9 * day)];
  const bodies = Object.fromEntries(["1", "2"].map(c => [index(c, 0).key, { version: 1, sourceSha256: source(c), sha256: sha(c), commit: "c".repeat(40) }]));
  const client = store(objects, bodies);
  const plan = await pruneRuntimes(client, "runtimes", { protect: [sha("4")], now });
  const calls = client.send.mock.calls.map(([command]: any[]) => [command.constructor.name, command.input]);
  expect(calls.filter(([name]) => name === "ListObjectsV2Command").map(([, input]) => input.Prefix)).toEqual(["cloud-v2/runtime/", "cloud-v2/runtime/"]);
  const deletes = calls.filter(([name]) => name === "DeleteObjectsCommand").map(([, input]) => input.Delete.Objects.map((o: { Key: string }) => o.Key));
  expect(deletes).toEqual([[index("1", 0).key, index("2", 0).key], [archive("2", 0).key, archive("1", 0).key]]);
  expect(plan.kept.sort()).toEqual([sha("3"), sha("4")]);
});

it("treats a malformed index as unreadable and reports a refused delete", async () => {
  const objects = [archive("1", 10 * day), archive("2", 9 * day), archive("3", 8 * day), index("1", 9 * day)];
  const malformed = store(objects, { [index("1", 0).key]: { version: 1, sourceSha256: source("2"), sha256: sha("1"), commit: "c".repeat(40) } });
  const plan = await pruneRuntimes(malformed, "runtimes", { protect: [], now });
  expect(plan.indices).toEqual([]);
  expect(plan.archives).toEqual([archive("1", 0).key]);
  await expect(pruneRuntimes(store(objects, {}, true), "runtimes", { protect: [], now })).rejects.toThrow(/could not delete/);
});
