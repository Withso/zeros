import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { clearWebhookReclaim, devRuntimeRetentionMode, planDevRuntimeRetention, planRuntimeRetention, pruneRuntimes, recordRuntimeUse, recordWebhookReclaim,
  removeRuntimeUses, retainDevRuntimes, runtimeUseOwners, webhookReclaimed, type StoredObject } from "./runtime-retention.js";

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

it("plans nothing for a release-managed store", () => {
  const plan = planRuntimeRetention([archive("1", 30 * day), archive("2", 20 * day), archive("3", 10 * day), archive("4", 0),
    { key: `cloud-v2/runtime/releases/receipts/alpha/1/1.json`, lastModified: new Date(now - 30 * day), size: 1 }], new Map(), { protect: [], now });
  expect(plan).toMatchObject({ managed: true, archives: [], indices: [], bytes: 0 });
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

it("retires digest-bound capabilities with their archive while preserving protected and recent records", async () => {
  const capability = (c: string, age: number): StoredObject => ({ key: `cloud-v2/runtime/capabilities/${sha(c)}.json`, lastModified: new Date(now - age), size: 256 });
  const objects = [archive("1", 10 * day), archive("2", 9 * day), archive("3", 8 * day), archive("4", 0),
    capability("1", 9 * day), capability("2", 9 * day), capability("5", 9 * day), capability("6", hour)];
  const client = store(objects, {});
  const plan = await pruneRuntimes(client, "runtimes", { protect: [sha("2")], now });
  expect(plan.indices.sort()).toEqual([capability("1", 0).key, capability("5", 0).key].sort());
  expect(plan.archives).toEqual([archive("1", 0).key]);
  const deletes = client.send.mock.calls.map(([command]: any[]) => command).filter(command => command.constructor.name === "DeleteObjectsCommand");
  expect(deletes.map(command => command.input.Delete.Objects.map((o: { Key: string }) => o.Key))).toEqual([
    [capability("1", 0).key, capability("5", 0).key], [archive("1", 0).key],
  ]);
  expect(client.send.mock.calls.some(([command]: any[]) => command.constructor.name === "GetObjectCommand")).toBe(false);
});

describe("headless Dev runtime retention", () => {
  const instance = "11111111-2222-4333-8444-555555555555", other = "66666666-7777-4888-9999-aaaaaaaaaaaa";
  const owners: Record<string, string> = { [instance]: "a".repeat(24), [other]: "b".repeat(24) };
  const use = (c: string, who: string, age: number): StoredObject => ({ key: `cloud-v2/runtime/uses/${sha(c)}/${owners[who]}/${who}.json`, lastModified: new Date(now - age), size: 60 });
  const since = (age: number): StoredObject => ({ key: "cloud-v2/runtime/uses/since.json", lastModified: new Date(now - age), size: 40 });
  const capabilities = (c: string): StoredObject => ({ key: `cloud-v2/runtime/capabilities/${sha(c)}.json`, lastModified: new Date(now - 30 * day), size: 200 });
  // 1 is this checkout's current runtime and 7 its previous one (both old); 2 is marked by another checkout within the
  // week; 3 and 6 were last marked over a week ago; 4 was never marked; 5 was published yesterday and not yet marked.
  const objects = (markersFor: number) => [since(markersFor), archive("1", 30 * day), archive("2", 30 * day), archive("3", 30 * day), archive("4", 30 * day),
    archive("5", day), archive("6", 30 * day), archive("7", 30 * day), use("2", other, 6 * day), use("3", other, 8 * day), use("3", instance, 9 * day),
    use("6", other, 10 * day), use("7", instance, 20 * day), index("3", 30 * day), index("4", 30 * day), capabilities("4"), capabilities("6")];
  const targets = new Map([[index("3", 0).key, sha("3")], [index("4", 0).key, sha("4")]]);
  const options = { current: sha("1"), previous: sha("7"), now, mode: "apply" as const };

  it("removes only runtimes whose newest mark is over a week old, with their indices, capabilities and markers", () => {
    const plan = planDevRuntimeRetention(objects(30 * day), targets, options);
    expect(plan.status).toBe("planned");
    expect(plan.kept).toEqual([{ sha256: sha("1"), reason: "current" }, { sha256: sha("2"), reason: "used" }, { sha256: sha("4"), reason: "unmarked" },
      { sha256: sha("5"), reason: "unmarked" }, { sha256: sha("7"), reason: "previous" }]);
    expect(plan.remove.map(item => [item.sha256, item.lastUsed])).toEqual([[sha("3"), new Date(now - 8 * day).toISOString()], [sha("6"), new Date(now - 10 * day).toISOString()]]);
    expect(plan.keys.archives).toEqual([archive("3", 0).key, archive("6", 0).key]);
    expect(plan.keys.indices.sort()).toEqual([index("3", 0).key, capabilities("6").key].sort());
    expect(plan.keys.uses.sort()).toEqual([use("3", other, 0).key, use("3", instance, 0).key, use("6", other, 0).key].sort());
    expect(plan.bytes).toBe(2 * 300e6);
  });
  it("keeps a runtime uploaded this week even when its only mark is older", () => {
    const plan = planDevRuntimeRetention([archive("1", 0), archive("9", 2 * day), use("9", other, 8 * day)], new Map(), { ...options, previous: null });
    expect(plan.kept).toContainEqual({ sha256: sha("9"), reason: "recent" }); expect(plan.remove).toEqual([]);
  });
  it("never removes an archive no checkout ever marked, however old, and plans nothing on a release-managed store", () => {
    const unmarked = planDevRuntimeRetention([since(60 * day), archive("1", 0), archive("4", 60 * day), archive("8", 90 * day)], new Map(), { ...options, previous: null });
    expect(unmarked.remove).toEqual([]);
    expect(unmarked.kept.filter(item => item.reason === "unmarked").map(item => item.sha256)).toEqual([sha("4"), sha("8")]);
    const managed = [...objects(30 * day), { key: "cloud-v2/runtime/releases/manifests/x.json", lastModified: new Date(now), size: 1 }];
    expect(planDevRuntimeRetention(managed, targets, options)).toMatchObject({ status: "managed", remove: [] });
    expect(() => planDevRuntimeRetention([], targets, { ...options, previous: "not-a-digest" })).toThrow();
  });
  it("applies only when the variable is exactly apply", () => {
    expect(devRuntimeRetentionMode("apply")).toBe("apply");
    for (const value of [undefined, "", "dry-run", "APPLY"]) expect(devRuntimeRetentionMode(value)).toBe("dry-run");
  });
  it("keeps a runtime another checkout marked this week out of the publisher's prune", () => {
    const plan = planRuntimeRetention([archive("1", 10 * day), archive("2", 9 * day), archive("3", 2 * hour), archive("4", 0), use("1", other, 2 * day)],
      new Map(), { protect: [], now });
    expect(plan.archives).toEqual([archive("2", 0).key]);
  });

  function bucket(listing: StoredObject[], bodies: Record<string, unknown> = {}) {
    return { send: vi.fn(async (command: any) => {
      const name = command.constructor.name, input = command.input;
      if (name === "ListObjectsV2Command") return { Contents: listing.filter(o => o.key.startsWith(input.Prefix)).map(o => ({ Key: o.key, LastModified: o.lastModified, Size: o.size })), IsTruncated: false };
      if (name === "GetObjectCommand") return { Body: Readable.from([Buffer.from(JSON.stringify(bodies[input.Key]))]) };
      if (name === "PutObjectCommand") { if (input.IfNoneMatch && listing.some(o => o.key === input.Key)) throw { $metadata: { httpStatusCode: 412 } }; return {}; }
      if (name === "DeleteObjectsCommand") return {};
      throw new Error(`unexpected ${name}`);
    }) };
  }
  const calls = (client: ReturnType<typeof bucket>) => client.send.mock.calls.map(([command]: any[]) => [command.constructor.name, command.input]);
  const record = (c: string) => ({ version: 1, sourceSha256: source(c), sha256: sha(c), commit: "c".repeat(40) });

  it("marks this checkout's runtime and starts the marker clock once", async () => {
    const fresh = bucket([]);
    await recordRuntimeUse(fresh, "dev", sha("1"), { owner: "a".repeat(24), instance }, now);
    expect(calls(fresh).map(([, input]) => input.Key)).toEqual([`cloud-v2/runtime/uses/${sha("1")}/${"a".repeat(24)}/${instance}.json`, "cloud-v2/runtime/uses/since.json"]);
    expect(calls(fresh)[1]![1].IfNoneMatch).toBe("*");
    await expect(recordRuntimeUse(bucket([since(day)]), "dev", sha("1"), { owner: "a".repeat(24), instance }, now)).resolves.toBeUndefined();
    await expect(recordRuntimeUse(fresh, "dev", sha("1"), { owner: "a".repeat(24), instance: "../other" }, now)).rejects.toThrow();
    await expect(recordRuntimeUse(fresh, "dev", sha("1"), { owner: "../owner", instance }, now)).rejects.toThrow();
  });
  it("deletes nothing in dry-run, and in apply deletes indices, then archives, then markers", async () => {
    const bodies = { [index("3", 0).key]: record("3"), [index("4", 0).key]: record("4") };
    const dry = bucket(objects(30 * day), bodies);
    expect(await retainDevRuntimes(dry, "dev", { ...options, mode: "dry-run" })).toMatchObject({ status: "planned", remove: [{ sha256: sha("3") }, { sha256: sha("6") }] });
    expect(calls(dry).some(([name]) => name === "DeleteObjectsCommand")).toBe(false);
    const live = bucket(objects(30 * day), bodies);
    expect(await retainDevRuntimes(live, "dev", options)).toMatchObject({ status: "deleted" });
    const deletes = calls(live).filter(([name]) => name === "DeleteObjectsCommand").map(([, input]) => input.Delete.Objects.map((o: any) => o.Key));
    expect(deletes).toHaveLength(3);
    expect(deletes[0].sort()).toEqual([index("3", 0).key, capabilities("6").key].sort());
    expect(deletes[1]).toEqual([archive("3", 0).key, archive("6", 0).key]);
    expect(deletes[2].every((key: string) => key.includes("/uses/"))).toBe(true);
  });
  it("re-reads a planned runtime's markers just before deleting it, and keeps it if a checkout marked it meanwhile", async () => {
    const listing = objects(30 * day), bodies = { [index("3", 0).key]: record("3") };
    const client = bucket(listing, bodies), send = client.send.getMockImplementation()!;
    // Another checkout starts on runtime 3 after the full listing: its new marker appears only in the per-runtime re-read.
    client.send.mockImplementation(async (command: any) => {
      if (command.constructor.name === "ListObjectsV2Command" && command.input.Prefix === `cloud-v2/runtime/uses/${sha("3")}/`)
        return { Contents: [use("3", other, 0)].map(o => ({ Key: o.key, LastModified: o.lastModified, Size: o.size })), IsTruncated: false };
      return send(command);
    });
    const plan = await retainDevRuntimes(client, "dev", options);
    expect(plan.remove.map(item => item.sha256)).toEqual([sha("6")]);
    expect(plan.kept).toContainEqual({ sha256: sha("3"), reason: "used" });
    const deleted = calls(client).filter(([name]) => name === "DeleteObjectsCommand").flatMap(([, input]) => input.Delete.Objects.map((o: any) => o.Key));
    expect(deleted.join()).not.toContain(sha("3"));
    expect(deleted).toContain(archive("6", 0).key);
  });
  it("refuses a truncated listing without a continuation token", async () => {
    const client = { send: vi.fn(async () => ({ Contents: [], IsTruncated: true })) };
    await expect(retainDevRuntimes(client, "dev", options)).rejects.toThrow(/incomplete/);
    await expect(pruneRuntimes(client, "dev", { protect: [], now })).rejects.toThrow(/incomplete/);
  });
  it("names the owners that marked a runtime this week, and when markers began", async () => {
    expect(await runtimeUseOwners(bucket(objects(8 * day)), "dev", now)).toEqual({ since: new Date(now - 8 * day).toISOString(), active: ["b".repeat(24)] });
    expect(await runtimeUseOwners(bucket([]), "dev", now)).toEqual({ since: null, active: [] });
  });
  it("records, reads and clears a WorkOS reclaim for one checkout, and treats a missing record as none", async () => {
    const stored = new Map<string, string>();
    const client = { send: vi.fn(async (command: any) => {
      const name = command.constructor.name, input = command.input;
      if (name === "PutObjectCommand") { stored.set(input.Key, input.Body); return {}; }
      if (name === "GetObjectCommand") {
        const body = stored.get(input.Key); if (body === undefined) throw { $metadata: { httpStatusCode: 404 } };
        return { ContentLength: body.length, Body: Readable.from([Buffer.from(body)]) };
      }
      if (name === "DeleteObjectsCommand") { for (const o of input.Delete.Objects) stored.delete(o.Key); return {}; }
      throw new Error(`unexpected ${name}`);
    }) };
    const me = { owner: "a".repeat(24), instance };
    expect(await webhookReclaimed(client, "dev", me)).toBeNull();
    await recordWebhookReclaim(client, "dev", me, "we_123", now);
    expect([...stored.keys()]).toEqual([`cloud-v2/runtime/uses/webhooks/${"a".repeat(24)}/${instance}.json`]);
    expect(await webhookReclaimed(client, "dev", me)).toBe("we_123");
    await clearWebhookReclaim(client, "dev", me);
    expect(await webhookReclaimed(client, "dev", me)).toBeNull();
    await expect(recordWebhookReclaim(client, "dev", me, "../x", now)).rejects.toThrow();
    await expect(webhookReclaimed(client, "dev", { owner: "../x", instance })).rejects.toThrow();
    // Reclaim records are not runtime markers: Dev runtime cleanup neither keeps nor removes runtimes for them.
    const plan = planDevRuntimeRetention([...objects(8 * day), { key: `cloud-v2/runtime/uses/webhooks/${"a".repeat(24)}/${instance}.json`, lastModified: new Date(now), size: 50 }],
      new Map(), { current: sha("1"), now, mode: "apply" });
    expect(plan.keys.uses.some(key => key.includes("/webhooks/"))).toBe(false);
  });
  it("removes only this checkout's markers on reset", async () => {
    const client = bucket(objects(8 * day));
    expect(await removeRuntimeUses(client, "dev", instance)).toBe(2);
    const [deleted] = calls(client).filter(([name]) => name === "DeleteObjectsCommand");
    expect(deleted![1].Delete.Objects).toEqual([{ Key: use("3", instance, 0).key }, { Key: use("7", instance, 0).key }]);
  });
});
