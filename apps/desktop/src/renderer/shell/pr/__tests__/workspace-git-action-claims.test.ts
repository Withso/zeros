import { beforeEach, expect, it } from "vitest";
import {
  claimPrCreateAction,
  isPrCreateActionClaimed,
} from "../pr-create-claim";
import {
  claimWorkspaceGitAction,
  releaseWorkspaceGitAction,
  workspaceGitActionClaim,
  resetWorkspaceGitActionClaimsForTesting,
} from "../workspace-git-action-claims";

beforeEach(resetWorkspaceGitActionClaimsForTesting);
it("serializes Summary, PR-row and Create PR actions across remounts", () => {
  const push = claimWorkspaceGitAction("a", {
    kind: "push",
    behavior: "push",
  })!;
  expect(isPrCreateActionClaimed("a")).toBe(true);
  expect(claimPrCreateAction("a")).toBeNull();
  expect(
    claimWorkspaceGitAction("a", { kind: "pull", behavior: "pull" }),
  ).toBeNull();
  expect(claimPrCreateAction("b")).not.toBeNull();
  releaseWorkspaceGitAction(push);
  const create = claimPrCreateAction("a")!;
  releaseWorkspaceGitAction(push);
  expect(workspaceGitActionClaim("a")).toBe(create);
});
it("preserves Archive's prompt replacement without releasing a newer operation", () => {
  const prompt = claimWorkspaceGitAction("a", {
    kind: "resolve",
    behavior: "prompt",
  })!;
  const archive = claimWorkspaceGitAction("a", {
    kind: "archive",
    behavior: "archive",
  })!;
  expect(archive).not.toBeNull();
  releaseWorkspaceGitAction(prompt);
  expect(workspaceGitActionClaim("a")).toBe(archive);
  releaseWorkspaceGitAction(archive);
  const createPrompt = claimPrCreateAction("a", "prompt")!;
  const replaceCreate = claimWorkspaceGitAction("a", {
    kind: "archive",
    behavior: "archive",
  })!;
  expect(replaceCreate).not.toBeNull();
  releaseWorkspaceGitAction(createPrompt);
  expect(workspaceGitActionClaim("a")).toBe(replaceCreate);
  releaseWorkspaceGitAction(replaceCreate);
  claimPrCreateAction("a");
  expect(
    claimWorkspaceGitAction("a", { kind: "archive", behavior: "archive" }),
  ).toBeNull();
});
