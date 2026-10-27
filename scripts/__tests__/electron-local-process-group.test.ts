import { afterEach, describe, expect, it, vi } from "vitest";
import { groupHasLiveMember, signalGroup } from "../electron-local-process-group.mjs";

const probe = vi.hoisted(() => ({ table: "", unavailable: false }));
vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFileSync: () => {
    if (probe.unavailable) throw new Error("synthetic unavailable process table");
    return probe.table;
  },
}));
afterEach(() => { vi.restoreAllMocks(); probe.table = ""; probe.unavailable = false; });

describe("Local process group liveness", () => {
  it("counts running and sleeping members of the group only", () => {
    const table = ["  101   100 Ss", "  102   100 S+", "  201   200 R"].join("\n");
    expect(groupHasLiveMember(table, 100)).toBe(true);
    expect(groupHasLiveMember(table, 200)).toBe(true);
    expect(groupHasLiveMember(table, 300)).toBe(false);
  });

  it("ignores zombies and members stuck exiting with no task left", () => {
    // A killed simulator tool can stay "?E" (exiting, no threads) for hours;
    // waiting on it hung the launcher in a ps loop after quit.
    expect(groupHasLiveMember("  101   100 Z\n  102   100 ?E  ", 100)).toBe(false);
    expect(groupHasLiveMember("  101   100 ?E\n  102   100 S", 100)).toBe(true);
  });

  it("keeps waiting for members that are exiting but still have threads", () => {
    expect(groupHasLiveMember("  101   100 RE", 100)).toBe(true);
    expect(groupHasLiveMember("  101   100 UE", 100)).toBe(true);
  });

  it("accepts a denied signal only after confirming the group has no live members", () => {
    probe.table = "  101   100 ?E\n  102   100 Z";
    vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("kill EPERM"), { code: "EPERM" }); });
    expect(() => signalGroup(100, "SIGTERM")).not.toThrow();
  });

  it.each(["live", "unknown"])("keeps a denied signal to a %s group as a failure", state => {
    probe.table = "  101   100 S";
    probe.unavailable = state === "unknown";
    vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("kill EPERM"), { code: "EPERM" }); });
    expect(() => signalGroup(100, "SIGTERM")).toThrow("kill EPERM");
  });
});
