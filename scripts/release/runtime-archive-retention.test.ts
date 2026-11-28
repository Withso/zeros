import { describe, expect, it, vi } from "vitest";
import { SYSTEM_DATABASE_CONTEXT } from "../../apps/control-plane/src/db-context";
import { planRuntimeArchiveRetention, readRuntimeReferences, retainRuntimeArchives, runtimeRetentionMode,
  type RuntimeStoredObject } from "./runtime-archive-retention";

const now = Date.parse("2026-11-27T12:00:00Z"), day = 86_400_000, MB = 333e6;
const sha = (c: string) => c.repeat(64);
const served = (c: string, age: number, size = MB): RuntimeStoredObject => ({ key: `cloud-v2/runtime/${sha(c)}.tar.gz`, lastModified: new Date(now - age), size });
const retained = (c: string, age: number, size = MB): RuntimeStoredObject => ({ key: `cloud-v2/runtime/releases/archives/${sha(c)}.tar.gz`, lastModified: new Date(now - age), size });
const both = (c: string, age: number) => [served(c, age), retained(c, age)];
const json = (key: string, age = 60 * day): RuntimeStoredObject => ({ key, lastModified: new Date(now - age), size: 300 });

// Ages: 1 is the current pin (oldest), 2 the previous; 3..5 old and unreferenced; 6 referenced; 7..9 newest; a within the window.
function listing() {
  return [...both("1", 40 * day), ...both("2", 30 * day), ...both("3", 20 * day), served("4", 15 * day), ...both("5", 12 * day),
    ...both("6", 25 * day), ...both("7", 9 * day), ...both("8", 9 * day + 1), ...both("9", 8 * day), ...both("a", 2 * day),
    json(`cloud-v2/runtime/releases/manifests/${sha("3")}.json`), json(`cloud-v2/runtime/capabilities/${sha("3")}.json`),
    json(`cloud-v2/runtime/releases/qualifications/${sha("3")}/1/1.json`), json(`cloud-v2/runtime/sources/${sha("e")}.json`),
    json("cloud-v2/runtime/releases/alpha/1/1.json"), json("cloud-v2/runtime/notes.txt")];
}
const input = { channel: "alpha" as const, mode: "dry-run" as const, current: sha("1"), previous: sha("2"), references: [sha("6")], now };

describe("runtime archive retention plan", () => {
  it("keeps pins, references, the last seven days and the newest three, and removes both copies of the rest", () => {
    const plan = planRuntimeArchiveRetention(listing(), input);
    const reasons = Object.fromEntries(plan.kept.map(item => [item.sha256[0], item.reasons]));
    expect(reasons).toEqual({ "1": ["current"], "2": ["previous"], "6": ["referenced"], "7": ["newest"], "9": ["newest"], a: ["recent", "newest"] });
    expect(plan.remove.map(item => item.sha256[0])).toEqual(["3", "4", "5", "8"]);
    expect(plan.remove.find(item => item.sha256 === sha("3"))!.keys).toEqual([`cloud-v2/runtime/${sha("3")}.tar.gz`, `cloud-v2/runtime/releases/archives/${sha("3")}.tar.gz`]);
    expect(plan.remove.find(item => item.sha256 === sha("4"))!.keys).toEqual([`cloud-v2/runtime/${sha("4")}.tar.gz`]);
    expect(plan.remove.flatMap(item => item.keys).every(key => key.endsWith(".tar.gz"))).toBe(true);
    expect(plan.totals).toEqual({ keptBytes: 12 * MB, removeBytes: 7 * MB, removeObjects: 7, removeUsdPerMonth: 0.03 });
    expect(plan).toMatchObject({ status: "planned", reason: null, rule: { windowDays: 7, newest: 3 }, pins: { current: sha("1"), previous: sha("2") } });
  });
  it("counts a runtime's latest write, so a re-copied pin is recent again", () => {
    const plan = planRuntimeArchiveRetention([...both("1", 0), served("3", 20 * day), retained("3", 1 * day), ...both("4", 30 * day),
      ...both("5", 30 * day), ...both("6", 30 * day)], { ...input, previous: sha("1") });
    expect(plan.kept.find(item => item.sha256 === sha("3"))!.reasons).toContain("recent");
  });
  it("keeps everything young enough, however many runtimes there are", () => {
    const plan = planRuntimeArchiveRetention([..."123456789".split("").flatMap((c, i) => both(c, i * day / 2))], input);
    expect(plan.remove).toEqual([]);
  });
  it("refuses invalid pins or references rather than planning around them", () => {
    expect(() => planRuntimeArchiveRetention(listing(), { ...input, references: ["not-a-digest"] })).toThrow();
    expect(() => planRuntimeArchiveRetention(listing(), { ...input, previous: "" })).toThrow();
  });
  it("applies only when the variable is exactly apply", () => {
    expect(runtimeRetentionMode({ ZEROS_RUNTIME_RETENTION: "apply" })).toBe("apply");
    for (const value of [undefined, "", "dry-run", "APPLY", "true", " apply"]) expect(runtimeRetentionMode({ ZEROS_RUNTIME_RETENTION: value })).toBe("dry-run");
  });
});

describe("runtime archive retention run", () => {
  const store = (objects = listing()) => ({ listRuntimeObjects: vi.fn(async () => objects), deleteRuntimeArchives: vi.fn(async (_keys: readonly string[]) => {}) });
  const run = (overrides: Partial<Parameters<typeof retainRuntimeArchives>[0]> = {}) => {
    const s = (overrides.store ?? store()) as ReturnType<typeof store>;
    return { s, result: retainRuntimeArchives({ ...input, references: input.references, store: s, active: () => true, ...overrides }) };
  };
  it("reports in dry-run and deletes nothing", async () => {
    const { s, result } = run();
    expect(await result).toMatchObject({ status: "planned", mode: "dry-run", totals: { removeObjects: 7 } });
    expect(s.deleteRuntimeArchives).not.toHaveBeenCalled();
  });
  it("deletes exactly the planned archive keys in apply mode", async () => {
    const { s, result } = run({ mode: "apply" }), plan = await result;
    expect(plan.status).toBe("deleted");
    expect(s.deleteRuntimeArchives).toHaveBeenCalledOnce();
    expect(s.deleteRuntimeArchives.mock.calls[0]![0]).toEqual(plan.remove.flatMap(item => item.keys));
    for (const kept of ["1", "2", "6", "7", "9", "a"]) expect(s.deleteRuntimeArchives.mock.calls[0]![0].join()).not.toContain(sha(kept));
  });
  it("deletes nothing when the live references could not be read", async () => {
    const { s, result } = run({ mode: "apply", references: null });
    expect(await result).toMatchObject({ status: "refused", reason: "references_unavailable", remove: [] });
    expect(s.listRuntimeObjects).not.toHaveBeenCalled(); expect(s.deleteRuntimeArchives).not.toHaveBeenCalled();
  });
  it("deletes nothing when the listing fails or does not hold the confirmed pin's served archive", async () => {
    const failing = { listRuntimeObjects: vi.fn(async () => { throw new Error("synthetic-private-listing"); }), deleteRuntimeArchives: vi.fn() };
    expect(await run({ mode: "apply", store: failing as never }).result).toMatchObject({ status: "refused", reason: "listing_failed" });
    expect(failing.deleteRuntimeArchives).not.toHaveBeenCalled();
    const other = store(listing().filter(object => object.key !== `cloud-v2/runtime/${sha("1")}.tar.gz`)), r = run({ mode: "apply", store: other });
    expect(await r.result).toMatchObject({ status: "refused", reason: "current_archive_not_listed" });
    expect(other.deleteRuntimeArchives).not.toHaveBeenCalled();
  });
  it("deletes nothing when the store also holds another channel's release records", async () => {
    for (const key of ["cloud-v2/runtime/releases/production/42/1.json", "cloud-v2/runtime/releases/intents/production/42/1/0001.json"]) {
      const shared = store([...listing(), json(key)]), r = run({ mode: "apply", store: shared });
      expect(await r.result).toMatchObject({ status: "refused", reason: "shared_store", remove: [] });
      expect(shared.deleteRuntimeArchives).not.toHaveBeenCalled();
    }
    const own = store([...listing(), json("cloud-v2/runtime/releases/intents/alpha/42/1/0001.json")]);
    expect(await run({ mode: "apply", store: own }).result).toMatchObject({ status: "deleted" });
  });
  it("deletes nothing after cancellation and reports a failed delete without throwing", async () => {
    const cancelled = run({ mode: "apply", active: () => false });
    expect(await cancelled.result).toMatchObject({ status: "refused", reason: "cancelled" });
    expect(cancelled.s.deleteRuntimeArchives).not.toHaveBeenCalled();
    const s = store(); s.deleteRuntimeArchives.mockRejectedValue(new Error("synthetic-private-delete"));
    const failed = await run({ mode: "apply", store: s }).result;
    expect(failed).toMatchObject({ status: "failed", reason: "delete_failed" });
    expect(JSON.stringify(failed)).not.toContain("synthetic-private");
  });
});

describe("runtime references", () => {
  function pool(rows: unknown[], system = "on", protocol = "1") {
    const calls: string[] = [], release = vi.fn();
    const client = { release, query: vi.fn(async (text: string) => {
      calls.push(text);
      if (text.includes("current_setting")) return { rows: [{ system, protocol }] };
      if (text.includes("SELECT DISTINCT sha")) return { rows };
      return { rows: [] };
    }) };
    return { calls, release, pool: { connect: vi.fn(async () => client) } };
  }
  it("reads every live reference in one read-only system transaction", async () => {
    const p = pool([{ sha: sha("1") }, { sha: sha("2") }]);
    expect(await readRuntimeReferences(p.pool)).toEqual([sha("1"), sha("2")]);
    expect(p.calls[0]).toMatch(/^BEGIN READ ONLY;/);
    expect(p.calls[1]).toBe(SYSTEM_DATABASE_CONTEXT);
    expect(p.calls.at(-1)).toBe("COMMIT"); expect(p.release).toHaveBeenCalledOnce();
    for (const table of ["cloud_v2_runtime_canaries", "cloud_v2_execution_creations", "cloud_v2_execution_activations", "cloud_v2_recovery_attempts",
      "cloud_worker_runtime_handoffs", "cloud_v2_computer_builds", "cloud_v2_shared_bases", "cloud_runtime_build_drain", "worker_runtime_sha256"])
      expect(p.calls.find(text => text.includes("SELECT DISTINCT sha"))).toContain(table);
  });
  it("refuses when row security is not open or a row is not a digest, and rolls back", async () => {
    for (const closed of [pool([], ""), pool([], "on", "")]) {
      await expect(readRuntimeReferences(closed.pool)).rejects.toThrow(/system read policy/);
      expect(closed.calls.at(-1)).toBe("ROLLBACK"); expect(closed.release).toHaveBeenCalledOnce();
    }
    const invalid = pool([{ sha: "not-a-digest" }]);
    await expect(readRuntimeReferences(invalid.pool)).rejects.toThrow(/invalid/);
    expect(invalid.calls.at(-1)).toBe("ROLLBACK");
  });
});
