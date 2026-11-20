import { describe, expect, it } from "vitest";
import { cloudComputerV2BuildRequired } from "../../../features/settings/cloud-computer-v2-create-gate";
import { ADD_CLOUD_REPOSITORY_REASON, createTrayState } from "../create-tray";

const base = {
  notice: null,
  reason: null,
  checking: false,
  computerRequired: false,
  computerReason: null,
  canManageComputer: false,
};

describe("Create tray", () => {
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
