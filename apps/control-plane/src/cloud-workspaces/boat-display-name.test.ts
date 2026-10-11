import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import type { BoatApiClient } from "./boat-client.js";
import {
  boatComputerDisplayName, boatRuntimeDisplayName, boatWorkspaceDisplayName, setBoatDisplayName,
} from "./boat-display-name.js";

const owner = { organizationSlug: "  Example__Org / TEAM  ", organizationId: "11111111-1111-4111-8111-111111111111" };
const workspace = { ...owner, workspaceSlug: "  Add...Search___UI  ", workspaceId: "22222222-2222-4222-8222-222222222222", channel: "alpha" };

describe("Boat display names", () => {
  it("normalizes tenant and workspace slugs without using them as identities", () => {
    expect(boatWorkspaceDisplayName(workspace)).toBe("example-org-team-alpha-workspace-add-search-ui");
    expect(boatComputerDisplayName({ ...owner, channel: "beta", version: 42 })).toBe("example-org-team-beta-computer-v42");
  });

  it.each(["", " --___ / ", "日本語"])("uses ID prefixes for empty normalized slugs: %j", slug => {
    expect(boatWorkspaceDisplayName({ ...workspace, organizationSlug: slug, workspaceSlug: slug }))
      .toBe("11111111-111-alpha-workspace-22222222-222");
    expect(boatComputerDisplayName({ ...owner, organizationSlug: slug, channel: "production", version: 1 }))
      .toBe("11111111-111-production-computer-v1");
  });

  it("bounds every part, keeping both workspace slugs and the full Computer version", () => {
    const long = { ...workspace, organizationSlug: "a".repeat(200), workspaceSlug: "b".repeat(200), channel: "c".repeat(200) };
    expect(boatWorkspaceDisplayName(long)).toBe(`${"a".repeat(46)}-${"c".repeat(16)}-workspace-${"b".repeat(46)}`);
    expect(boatWorkspaceDisplayName(long)).toHaveLength(120);
    expect(boatComputerDisplayName({ ...long, version: Number.MAX_SAFE_INTEGER }))
      .toBe(`${"a".repeat(46)}-${"c".repeat(16)}-computer-v9007199254740991`);
    const names = [boatWorkspaceDisplayName({ ...long, organizationSlug: `${"a".repeat(45)}-tail`, workspaceSlug: `${"b".repeat(45)}-tail` }),
      boatComputerDisplayName({ ...long, version: "9223372036854775807" }), boatRuntimeDisplayName(long.channel, "qualify")];
    for (const name of names) {
      expect(name.length).toBeLessThanOrEqual(120);
      expect(name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
  });

  it.each(["alpha", "beta", "production", "development"])("uses the deployment channel %s for every runtime purpose", channel => {
    for (const purpose of ["build", "check", "qualify"] as const)
      expect(boatRuntimeDisplayName(channel, purpose)).toBe(`zeros-${channel}-runtime-${purpose}`);
  });

  it("only patches the bound ID, with a short deadline and no create key", async () => {
    const client = { request: vi.fn(async () => ({})) };
    await setBoatDisplayName(client, "bx_23456789", async () => boatWorkspaceDisplayName(workspace));
    expect(client.request).toHaveBeenCalledExactlyOnceWith("/sandboxes/bx_23456789", {
      method: "PATCH", body: { name: "example-org-team-alpha-workspace-add-search-ui" },
      timeoutMs: 1000, signal: expect.any(AbortSignal),
    });
  });

  it("treats missing labels, lookup failures and PATCH failures as best effort", async () => {
    const client = { request: vi.fn(async () => { throw new Error("private provider detail"); }) };
    await expect(setBoatDisplayName(client, "bx_23456789", async () => null)).resolves.toBeUndefined();
    await expect(setBoatDisplayName(client, "bx_23456789", async () => { throw new Error("lookup unavailable"); })).resolves.toBeUndefined();
    expect(client.request).not.toHaveBeenCalled();
    await expect(setBoatDisplayName(client, "bx_23456789", async () => "zeros-alpha-runtime-build")).resolves.toBeUndefined();
    expect(client.request).toHaveBeenCalledTimes(1);
  });

  it.each(["resolve", "reject"] as const)("bounds a hung lookup to one second and ignores its later %s", async outcome => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let resolveName!: (name: string) => void;
    let rejectName!: (error: Error) => void;
    const name = new Promise<string>((resolve, reject) => { resolveName = resolve; rejectName = reject; });
    const client = { request: vi.fn(async () => ({})) };
    const finished = vi.fn(), unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const task = setBoatDisplayName(client, "bx_23456789", () => name).then(finished);
    try {
      await vi.advanceTimersByTimeAsync(999);
      expect(finished).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(finished).toHaveBeenCalledTimes(1);
      if (outcome === "resolve") resolveName("zeros-alpha-runtime-build");
      else rejectName(new Error("late lookup failure"));
      await nextTurn();
      expect(client.request).not.toHaveBeenCalled();
      expect(unhandled).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      resolveName("zeros-alpha-runtime-build");
      await task;
      process.off("unhandledRejection", unhandled);
      vi.useRealTimers();
    }
  });

  it("shares the one-second deadline across lookup and PATCH, catching a rejection after abort", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let resolveName!: (name: string) => void;
    let rejectPatch!: (error: Error) => void;
    const name = new Promise<string>(resolve => { resolveName = resolve; });
    const patch = new Promise<never>((_resolve, reject) => { rejectPatch = reject; });
    const client = { request: vi.fn<BoatApiClient["request"]>(async () => patch) };
    const finished = vi.fn(), unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const task = setBoatDisplayName(client, "bx_23456789", () => name).then(finished);
    try {
      await vi.advanceTimersByTimeAsync(750);
      resolveName("zeros-alpha-runtime-build");
      await vi.advanceTimersByTimeAsync(249);
      expect(client.request).toHaveBeenCalledTimes(1);
      const signal = client.request.mock.calls[0]![1]!.signal!;
      expect(signal.aborted).toBe(false);
      expect(finished).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(finished).toHaveBeenCalledTimes(1);
      expect(signal.aborted).toBe(true);
      rejectPatch(new Error("late PATCH failure"));
      await nextTurn();
      expect(unhandled).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      resolveName("zeros-alpha-runtime-build");
      rejectPatch(new Error("release pending PATCH"));
      await task;
      process.off("unhandledRejection", unhandled);
      vi.useRealTimers();
    }
  });
});
