import { describe, expect, it, vi } from "vitest";
import { BoatApiClient } from "./boat-client.js";
import { BoatRuntimeImageSnapshots, runtimeImageChannel } from "./runtime-images.js";

const NAME = `zeros-rtimg-alpha-${"a".repeat(12)}-0000aaaa`;
const SOURCE = "bx_23456789";
const WALLET = "team_11111111-1111-4111-8111-111111111111";

function fixture(replies: Array<{ status: number; body: Record<string, unknown> }>) {
  const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    const reply = replies.shift() ?? { status: 404, body: { ok: false, code: "not_found" } };
    return Response.json(reply.body, { status: reply.status });
  });
  const client = new BoatApiClient({ apiKey: "image-test-api-key", billingOrg: WALLET, timeoutMs: 1000, fetch: fetcher });
  return { fetcher, snapshots: new BoatRuntimeImageSnapshots(client) };
}
const snapshot = (status: string, extra: Record<string, unknown> = {}) => ({ name: NAME, status, sourceSandboxId: SOURCE,
  createdAt: "2026-10-11T00:00:00Z", ...extra });

describe("runtime image named snapshots", () => {
  it("saves under the exact name in the configured wallet", async () => {
    const f = fixture([{ status: 202, body: { ok: true, type: "snapshot.named.saving", status: "saving", snapshot: snapshot("saving") } }]);
    await expect(f.snapshots.save(SOURCE, NAME)).resolves.toBe("saving");
    const [url, init] = f.fetcher.mock.calls[0]!;
    expect(new URL(String(url)).pathname).toBe("/api/v1/named-snapshots");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ sandboxId: SOURCE, name: NAME });
    expect(new Headers(init?.headers).get("x-boat-org")).toBe(WALLET);
  });

  it("treats Boat's save conflict as the earlier save still running", async () => {
    const f = fixture([{ status: 409, body: { ok: false, code: "save_in_progress", message: "private detail" } }]);
    await expect(f.snapshots.save(SOURCE, NAME)).resolves.toBe("in_progress");
  });

  it.each([
    ["another name", { ...snapshot("saving"), name: "zeros-rtimg-alpha-bbbbbbbbbbbb-0000aaaa" }],
    ["an already settled save", snapshot("ready", { snapshotId: "snap_1", sizeBytes: 1 })],
    ["a malformed snapshot", { name: NAME }],
  ])("rejects a save reply naming %s", async (_label, value) => {
    const f = fixture([{ status: 202, body: { ok: true, status: "saving", snapshot: value } }]);
    await expect(f.snapshots.save(SOURCE, NAME)).rejects.toMatchObject({ diagnostic: { stage: "save", failedChecks: ["provider_response"] } });
  });

  it("never sends a malformed name or source", async () => {
    const f = fixture([]);
    for (const [source, name] of [[SOURCE, "Zeros-Upper"], [SOURCE, "zeros/../x"], ["bx_bad", NAME]])
      await expect(f.snapshots.save(source, name)).rejects.toMatchObject({ diagnostic: { failedChecks: ["input_schema"] } });
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("reads a ready snapshot without retaining Boat's free-text detail", async () => {
    const f = fixture([{ status: 200, body: { ok: true, snapshot: snapshot("ready", { snapshotId: "snap_1", sizeBytes: 42,
      error: "private provider detail" }) } }]);
    const value = await f.snapshots.get(NAME);
    expect(value).toEqual({ name: NAME, status: "ready", sourceSandboxId: SOURCE, snapshotId: "snap_1", sizeBytes: 42 });
    expect(JSON.stringify(value)).not.toContain("private");
  });

  it("reports a missing name as absent", async () => {
    const f = fixture([{ status: 404, body: { ok: false, code: "not_found" } }]);
    await expect(f.snapshots.get(NAME)).resolves.toBeNull();
  });

  it("removes with an exact delete confirmation and confirms absence by reading back", async () => {
    const f = fixture([{ status: 200, body: { ok: true } }, { status: 404, body: { ok: false } }]);
    await expect(f.snapshots.remove(NAME)).resolves.toBe("gone");
    const [url, init] = f.fetcher.mock.calls[0]!;
    expect(new URL(String(url)).pathname).toBe(`/api/v1/named-snapshots/${NAME}`);
    expect(init?.method).toBe("DELETE");
    expect(new Headers(init?.headers).get("x-ascii-confirm-delete")).toBe(NAME);
    expect(new URL(String(f.fetcher.mock.calls[1]![0])).pathname).toBe(`/api/v1/named-snapshots/${NAME}`);
  });

  it.each([
    ["a save still runs", [{ status: 409, body: { ok: false, code: "save_in_progress" } }], "in_progress"],
    ["the name is still readable", [{ status: 200, body: { ok: true } }, { status: 200, body: { ok: true, snapshot: snapshot("ready") } }], "in_progress"],
    ["the name was already gone", [{ status: 404, body: { ok: false } }, { status: 404, body: { ok: false } }], "gone"],
  ] as const)("does not confirm removal while %s", async (_label, replies, expected) => {
    const f = fixture(replies.map(reply => ({ ...reply, body: { ...reply.body } })));
    await expect(f.snapshots.remove(NAME)).resolves.toBe(expected);
  });

  it("produces images only for release channels", () => {
    expect(["alpha", "beta", "production"].map(runtimeImageChannel)).toEqual(["alpha", "beta", "production"]);
    expect(runtimeImageChannel("development")).toBeNull();
  });
});
