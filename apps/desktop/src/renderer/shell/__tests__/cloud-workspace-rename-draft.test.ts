import { describe, expect, it } from "vitest";
import { ControlPlaneError } from "../../features/team/control-plane";
import { rebaseRenameDraft, renameDraftAfterFailure } from "../conversation/cloud-workspace-details";

const draft = { name: "Typed name", version: 3, rebase: false };
const conflict = new ControlPlaneError(409, "cloud_workspace_version_conflict", "The cloud workspace metadata changed");

describe("cloud workspace rename drafts", () => {
  it("rebases a conflicted draft onto the refreshed version once and keeps the typed name", () => {
    const conflicted = renameDraftAfterFailure(draft, conflict);
    expect(rebaseRenameDraft(conflicted, 3)).toEqual({ ...draft, rebase: true });
    const rebased = rebaseRenameDraft(conflicted, 4);
    expect(rebased).toEqual({ name: "Typed name", version: 4, rebase: false });
    expect(rebaseRenameDraft(rebased, 5)).toBe(rebased);
  });
  it("never changes the compare-and-swap base without a version conflict", () => {
    for (const error of [new ControlPlaneError(409, "cloud_workspace_rename_conflict", "Other"), new ControlPlaneError(503, "unavailable", "Down"), new Error("network")])
      expect(rebaseRenameDraft(renameDraftAfterFailure(draft, error), 9)).toBe(draft);
  });
});
