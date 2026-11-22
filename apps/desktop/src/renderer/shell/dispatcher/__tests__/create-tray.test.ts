import { describe, expect, it } from "vitest";
import { cloudComputerV2BuildRequired, cloudComputerV2CheckFailed } from "../../../features/settings/cloud-computer-v2-create-gate";
import { ADD_CLOUD_REPOSITORY_REASON, GITHUB_CONNECTION_STATES, READY_COPY_BUILDING, SIGN_IN_FOR_CLOUD, createTrayState } from "../create-tray";

const base = {
  notice: null,
  reason: null,
  checking: false,
  computerRequired: false,
  computerReason: null,
  canManageComputer: false,
};

describe("Create tray", () => {
  it("says a repository is still getting ready while its first ready copy builds, below any blocking reason", () => {
    expect(createTrayState({ ...base, readyCopyBuilding: true })).toEqual({ message: READY_COPY_BUILDING, action: null });
    expect(createTrayState({ ...base, readyCopyBuilding: true, checking: true })).toBeNull();
    expect(createTrayState({ ...base, readyCopyBuilding: true, reason: "Creating a cloud workspace requires Pro." }))
      .toEqual({ message: "Creating a cloud workspace requires Pro.", action: null });
  });

  it("names a suspended or uninstalled GitHub App with the way to fix it", () => {
    for (const state of ["suspended", "uninstalled"] as const)
      expect(createTrayState({ ...base, connectionState: state })).toEqual({ message: GITHUB_CONNECTION_STATES[state], action: "github-settings" });
    expect(createTrayState({ ...base, connectionState: "suspended", reason: "Creating a cloud workspace requires Pro." }))
      .toEqual({ message: "Creating a cloud workspace requires Pro.", action: null });
  });

  it("is empty when Create can proceed or is still checking", () => {
    expect(createTrayState(base)).toBeNull();
    expect(createTrayState({ ...base, reason: "Checking Cloud availability…", checking: true })).toBeNull();
  });

  it.each([
    "Creating a cloud workspace requires Pro.",
    "You're on Hold in this organization. Get Pro, or ask an owner to free a seat.",
    "Select an organization with Cloud access.",
    "Choose a branch from Remote to create it in Cloud. Push local-only work to GitHub first.",
    "Cloud workspaces are not enabled in this desktop build.",
  ])("shows %s as one line with no action", (reason) => {
    expect(createTrayState({ ...base, reason })).toEqual({ message: reason, action: null });
  });

  it("offers Manage repositories when the Cloud Computer has none", () => {
    expect(createTrayState({ ...base, reason: ADD_CLOUD_REPOSITORY_REASON })).toEqual({
      message: ADD_CLOUD_REPOSITORY_REASON,
      action: "manage-repositories",
    });
  });

  it("offers sign-in when Personal's cloud needs an account", () => {
    expect(createTrayState({ ...base, reason: SIGN_IN_FOR_CLOUD })).toEqual({ message: "Sign in to create cloud workspaces.", action: "sign-in" });
  });

  it("offers the Cloud Computer settings when the Cloud Computer could not be checked", () => {
    expect(createTrayState({ ...base, reason: cloudComputerV2CheckFailed })).toEqual({
      message: cloudComputerV2CheckFailed,
      action: "cloud-computer-settings",
    });
  });

  it("asks admins to build the Cloud Computer and tells members who can", () => {
    const required = { ...base, reason: cloudComputerV2BuildRequired, computerRequired: true, computerReason: cloudComputerV2BuildRequired };
    expect(createTrayState({ ...required, canManageComputer: true })).toEqual({
      message: `${cloudComputerV2BuildRequired}.`,
      action: "cloud-computer-settings",
    });
    expect(createTrayState(required)).toEqual({
      message: `${cloudComputerV2BuildRequired}. Ask an organization admin to build it.`,
      action: null,
    });
  });

  it("shows a create notice before any reason", () => {
    expect(createTrayState({ ...base, notice: "The Cloud Computer changed.", reason: ADD_CLOUD_REPOSITORY_REASON }))
      .toEqual({ message: "The Cloud Computer changed.", action: null });
  });
});
