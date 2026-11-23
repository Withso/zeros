// Ready copies switched on safely: the Cloud Computer is prepared by Zeros, and every surface says what is happening
// instead of asking for a button or showing nothing.
import { describe, expect, it } from "vitest";
import { CloudV2BuildSchema, CloudV2ComputerReplySchema, type CloudV2Build } from "../../../platform/cloud-v2";
import { computerStatus, historyNote } from "../cloud-computer-model";
import { readyCopyBaseLine } from "../ready-copy-copy";
import { describeWorkspaceAvailability } from "../../../shell/workbench/tab-status-model";

const now = Date.parse("2026-11-22T12:00:00.000Z");
const build = (patch: Partial<CloudV2Build> = {}): CloudV2Build => ({
  id: "00000000-0000-4000-8000-000000000001", organizationId: "11111111-1111-4111-8111-111111111111", version: 3,
  recipe: { repositories: [] }, state: "succeeded", snapshotId: "zeros-alpha-org-3", errorCode: null,
  createdAt: "2026-11-20T09:00:00.000Z", startedAt: "2026-11-20T09:00:00.000Z", finishedAt: "2026-11-20T09:05:00.000Z", reason: "manual", ...patch,
});
const status = (builds: CloudV2Build[], base?: { state: string; errorCode?: string }) =>
  computerStatus({ builds, activeBuildId: builds.find(row => row.state === "succeeded")?.id ?? null, changes: [], configuredCount: 0, now, readyCopies: true, base });

describe("the Cloud Computer, prepared by Zeros", () => {
  it("says it is being prepared, and that workspaces can be created meanwhile", () => {
    expect(status([build({ state: "building", automatic: true, snapshotId: null })])).toEqual({ kind: "building",
      title: "Preparing the Cloud Computer…", detail: "Prepared automatically by Zeros. Workspaces can be created meanwhile." });
  });

  it("names the standard Zeros tools for the shared base, and how to customise it", () => {
    expect(status([build({ automatic: true, snapshotId: "zeros-base-1@00000000-0000-4000-8000-000000000001" })])).toMatchObject({
      kind: "built", title: "Uses the standard Zeros tools", detail: "Add an install script to customise it." });
  });

  it("shows a build nobody pressed, with its date", () => {
    const shown = status([build({ automatic: true })]);
    expect(shown.title).toMatch(/^Rebuilt automatically on /);
    expect(shown.title).toContain("2026");
    expect(historyNote(build({ automatic: true }))).toBe("Automatic");
    expect(historyNote(build({ automatic: true, reason: "runtime" }))).toBe("Automatic · runtime update");
    expect(historyNote(build({ automatic: true, snapshotId: "zeros-base-1@x" }))).toBe("Standard Zeros tools");
  });

  it("says why it could not be prepared and that Zeros tries again, never asking for a button", () => {
    const shown = status([build({ state: "failed", automatic: true, errorCode: "computer_install_script_failed" })],
      { state: "failed", errorCode: "computer_install_script_failed" });
    expect(shown).toEqual({ kind: "failed", title: "The Cloud Computer could not be prepared",
      detail: "The install script failed. Its output is in the build's log. Zeros tries again automatically." });
    expect(status([])).toEqual({ kind: "empty", title: "No build yet", detail: "Zeros prepares it with your first project or workspace." });
    for (const line of [shown.detail, status([]).detail]) expect(line).not.toMatch(/add a repository|build the computer/i);
  });

  it("keeps the wording of an ordinary build with ready copies off", () => {
    expect(computerStatus({ builds: [], activeBuildId: null, changes: [], configuredCount: 0, now })).toEqual({ kind: "empty",
      title: "No build yet", detail: "Add a repository below, then build the computer." });
  });

  it("parses an automatic build as a released desktop's schema did: the reason stays one it knows", () => {
    const sent = { ...build({ automatic: true }), createdBy: null, automatic: true };
    const released = CloudV2BuildSchema.omit({ automatic: true }).passthrough();
    expect(released.parse(sent)).toMatchObject({ reason: "manual", automatic: true });
    expect(CloudV2BuildSchema.parse(sent).automatic).toBe(true);
    expect(CloudV2ComputerReplySchema.parse({ activeBuildId: null, snapshotName: null, builds: [], readyCopies: true,
      base: { state: "failed", buildId: "x", errorCode: "computer_install_script_failed", failures: 2, nextAttemptAt: "2026-11-22T12:30:00.000Z" } }).base)
      .toMatchObject({ state: "failed", errorCode: "computer_install_script_failed" });
    // An unknown base state from a newer server is dropped, never a failed parse of the whole page.
    expect(CloudV2ComputerReplySchema.parse({ activeBuildId: null, snapshotName: null, builds: [], base: { state: "later" } }).base).toBeUndefined();
  });
});

describe("a project with no copy yet", () => {
  it("says it waits for the Cloud Computer, or why that failed and when Zeros tries again", () => {
    expect(readyCopyBaseLine({ state: "preparing" }, now)).toEqual({ label: "Preparing the Cloud Computer…",
      hint: "This project's build starts as soon as it is ready. Workspaces can be created meanwhile." });
    expect(readyCopyBaseLine({ state: "failed", reason: "computer_install_script_failed", nextAttemptAt: "2026-11-22T12:30:00.000Z" }, now)).toEqual({
      label: "The Cloud Computer could not be prepared",
      hint: "The install script failed. Its output is in the build's log. Zeros tries again automatically. Next try in 30 minutes." });
  });
});

describe("a workspace waiting for the Cloud Computer", () => {
  it("says so while it is created, and nothing new otherwise", () => {
    expect(describeWorkspaceAvailability({ cloud: true, state: "provisioning", connection: "disconnected", since: 0, preparingComputer: true }, now))
      .toEqual({ tone: "pending", message: "Preparing the Cloud Computer… This workspace starts as soon as it is ready." });
    expect(describeWorkspaceAvailability({ cloud: true, state: "provisioning", connection: "disconnected", since: 0 }, now))
      .toEqual({ tone: "pending", message: "This cloud workspace is still setting up." });
  });
});
