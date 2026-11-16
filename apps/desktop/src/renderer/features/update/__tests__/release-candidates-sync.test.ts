import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ channel: "stable", electron: true, invoke: vi.fn(async () => ({ applied: true })) }));
vi.mock("../../../config/release-channel", () => ({ get CHANNEL() { return runtime.channel; } }));
vi.mock("../../../platform/runtime", () => ({ isElectron: () => runtime.electron, nativeInvoke: runtime.invoke }));

import { releaseCandidateChoice, reportReleaseCandidateChoice, resetReleaseCandidatesSyncForTests } from "../release-candidates-sync";

const me = (staffRole: string | null) => ({ user: { staffRole } }) as never;

beforeEach(() => {
  Object.assign(runtime, { channel: "stable", electron: true });
  runtime.invoke.mockReset().mockResolvedValue({ applied: true });
  resetReleaseCandidatesSyncForTests();
});

describe("release candidate opt-in", () => {
  it("is unknown until the staff role is known", () => {
    expect(releaseCandidateChoice({ me: null, status: "idle" }, true)).toBeNull();
    expect(releaseCandidateChoice({ me: null, status: "loading" }, true)).toBeNull();
    expect(releaseCandidateChoice({ me: me("developer"), status: "loading" }, true)).toBeNull();
    expect(releaseCandidateChoice({ me: me("developer"), status: "error" }, true)).toBeNull();
  });

  it("is staff role AND the Internal flag once known", () => {
    expect(releaseCandidateChoice({ me: me("developer"), status: "ready" }, true)).toBe(true);
    expect(releaseCandidateChoice({ me: me("platform_owner"), status: "ready" }, true)).toBe(true);
    expect(releaseCandidateChoice({ me: me("developer"), status: "ready" }, false)).toBe(false);
    // A forged localStorage flag does nothing for an ordinary or retired-role account.
    expect(releaseCandidateChoice({ me: me(null), status: "ready" }, true)).toBe(false);
    expect(releaseCandidateChoice({ me: me("support_admin"), status: "ready" }, true)).toBe(false);
  });

  it("reports each change once, and nothing while unknown", async () => {
    reportReleaseCandidateChoice(null);
    reportReleaseCandidateChoice(true); reportReleaseCandidateChoice(true);
    reportReleaseCandidateChoice(false);
    expect(runtime.invoke.mock.calls).toEqual([["updater_release_candidates", { enabled: true }], ["updater_release_candidates", { enabled: false }]]);
  });

  it("retries after a failed report", async () => {
    runtime.invoke.mockRejectedValueOnce(new Error("no window"));
    reportReleaseCandidateChoice(true); await Promise.resolve(); await Promise.resolve();
    reportReleaseCandidateChoice(true);
    expect(runtime.invoke).toHaveBeenCalledTimes(2);
  });

  it.each([["alpha", true], ["dev", true], ["stable", false]] as const)("never reports from a %s build (Electron %s)", (channel, electron) => {
    Object.assign(runtime, { channel, electron });
    reportReleaseCandidateChoice(true);
    expect(runtime.invoke).not.toHaveBeenCalled();
  });
});
