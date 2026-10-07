import { afterEach, describe, expect, it, vi } from "vitest";
import { reportDesignDirectoryFailure } from "../design-directory-failure";

const error = vi.hoisted(() => vi.fn());
vi.mock("../../../shared/ui/primitives/elements", () => ({ toast: { error } }));

afterEach(() => { error.mockClear(); vi.restoreAllMocks(); });
describe("Design lifecycle action feedback", () => {
  it.each(["/tmp/personal", "/tmp/organization-local"])("keeps the Local toast contract for %s", workspace => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cause = new Error("Existing Local diagnostic");
    reportDesignDirectoryFailure(workspace, "create", cause);
    expect(error).toHaveBeenLastCalledWith("Couldn't create Design directory", { description: cause.message });
    reportDesignDirectoryFailure(workspace, "open", cause);
    expect(error).toHaveBeenLastCalledWith("Couldn't open Design directory", { description: cause.message });
    expect(warn).not.toHaveBeenCalled();
  });
  it.each(["create", "open", "register", "rename", "unregister", "inspect"] as const)("closes cloud %s failures to a short toast and bounded diagnostic", action => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    reportDesignDirectoryFailure("cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222", action,
      new Error("Command failed: git --work-tree=/tmp/private-probe fatal: this operation must be run in a work tree"));
    expect(error).toHaveBeenCalledExactlyOnceWith(`Couldn't ${action} the Design directory. Try again.`);
    expect(warn).toHaveBeenCalledExactlyOnceWith("[Design] Cloud directory action failed", { action, reason: "git_command_failed" });
  });

  it.each([
    ["rev_parse", "dubious_ownership"],
    ["check_ignore", "permission_denied"],
    ["policy_config", "invalid_configuration"],
  ])("reports the safe %s operation and failure category", (operation, category) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    reportDesignDirectoryFailure("cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222", "create",
      Object.assign(new Error(`Managed Git ${operation} failed (${category}).`), { code: "GIT_COMMAND_FAILED" }));
    expect(warn).toHaveBeenCalledExactlyOnceWith("[Design] Cloud directory action failed", {
      action: "create", reason: `git_${operation}_${category}`,
    });
    expect(error).toHaveBeenCalledExactlyOnceWith("Couldn't create the Design directory. Try again.");
  });

  it.each([
    "Managed Git /private/checkout failed (permission_denied).",
    "Managed Git check_ignore failed (/private/checkout).",
    "Managed Git check_ignore failed (permission_denied). /private/checkout",
  ])("rejects unrecognized diagnostic text without logging it", message => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    reportDesignDirectoryFailure("cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222", "create", new Error(message));
    expect(warn).toHaveBeenCalledExactlyOnceWith("[Design] Cloud directory action failed", { action: "create", reason: "operation_rejected" });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("/private/");
  });
});
