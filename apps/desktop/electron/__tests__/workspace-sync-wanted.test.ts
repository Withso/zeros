import { describe, expect, it, vi } from "vitest";
import { SyncWantedFollower, type SyncWantedDeps } from "../workspace-sync/wanted";

const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222", C = "33333333-3333-4333-8333-333333333333";
const row = (workspaceId: string, syncWanted: boolean, extra: Record<string, unknown> = {}) =>
  ({ workspaceId, repository: "Withso/zeros", number: 19, name: "Fix login", syncWanted, ...extra });

function fixture(pages: Array<{ connections: ReturnType<typeof row>[]; nextCursor: string | null } | Error>, running: string[] = []) {
  let now = 1_000_000;
  const runs = new Set(running), calls: string[] = [], cursors: Array<string | undefined> = [];
  const deps: SyncWantedDeps = {
    list: vi.fn(async (cursor?: string) => { cursors.push(cursor); const page = pages.shift(); if (!page || page instanceof Error) throw page ?? new Error("none"); return page; }),
    running: () => [...runs],
    folderFor: () => undefined,
    enable: vi.fn(async (workspaceId: string, folder: string) => { calls.push(`enable ${workspaceId.slice(0, 1)} ${folder}`); runs.add(workspaceId); }),
    disable: vi.fn(async (workspaceId: string) => { calls.push(`disable ${workspaceId.slice(0, 1)}`); runs.delete(workspaceId); }),
    home: "/Users/alex", now: () => now, log: () => {},
  };
  return { follower: new SyncWantedFollower(deps), calls, cursors, runs, advance: (ms: number) => { now += ms; } };
}

describe("following syncWanted for this Mac (12.z)", () => {
  it("collects every page, then starts wanted workspaces in their default folder, and stops one set to false or no longer connected here", async () => {
    const f = fixture([{ connections: [row(A, true)], nextCursor: A }, { connections: [row(B, false), row(C, true, { number: null, name: "Docs" })], nextCursor: null }], [B, "44444444-4444-4444-8444-444444444444"]);
    await f.follower.refresh();
    expect(f.cursors).toEqual([undefined, A]);
    // 4444… is not among this Mac's live connections (disconnected): an app restart must not keep syncing it.
    expect(f.calls).toEqual(["enable 1 /Users/alex/zeros/cloud-sync/zeros/w-19", "disable 2", "enable 3 /Users/alex/zeros/cloud-sync/zeros/Docs", "disable 4"]);
    expect([...f.runs].sort()).toEqual([A, C].sort());
  });

  it("changes nothing when any page fails (the prior state stays), and backs off a control plane without the route", async () => {
    const f = fixture([{ connections: [row(A, true)], nextCursor: A }, new Error("network")], [B]);
    await f.follower.refresh();
    expect(f.calls).toEqual([]);
    const old = fixture([Object.assign(new Error("not found"), { status: 404 })]);
    await old.follower.refresh();
    old.advance(60_000);
    await old.follower.refresh();
    expect(old.cursors).toEqual([undefined]);   // no retry storm on an older control plane
  });

  it("never undoes this Mac's own switch flipped while a read was in flight, and refreshes at most every 10 s on hints", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const f = fixture([{ connections: [row(A, false)], nextCursor: null }], [A]);
    const list = (f.follower as unknown as { deps: SyncWantedDeps }).deps.list as ReturnType<typeof vi.fn>;
    const original = list.getMockImplementation() as SyncWantedDeps["list"];
    list.mockImplementationOnce(async (cursor?: string) => { await gate; return original(cursor); });
    const pending = f.follower.refresh();
    f.follower.noteLocalChange(A);   // the person just turned it on here
    release();
    await pending;
    expect(f.calls).toEqual([]);
    f.advance(1_000);
    await f.follower.hint(); await f.follower.hint();
    expect(list).toHaveBeenCalledTimes(1);
  });
});
