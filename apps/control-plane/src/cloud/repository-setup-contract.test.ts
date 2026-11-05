import { describe, expect, it } from "vitest";
import { CloudV2ControlFrameSchema as protocol } from "../../../../packages/protocol/src/cloud-v2-relay.js";
import { CloudV2ControlFrameSchema as controlPlane } from "./contract.js";
import { CloudV2RecipeSchema, CloudV2RepositoryDraftSchema, editableRepositories } from "./computer.js";

const workspace = { id: "22222222-2222-4222-8222-222222222222", organizationId: "11111111-1111-4111-8111-111111111111",
  repository: "fixture/repo", checkoutPath: "/home/user/fixture/repo", branch: "topic", baseBranch: "main" };
const frame = (setupScript?: unknown) => ({ t: "config", loginRevision: "0", agents: {}, workspace: { ...workspace, ...(setupScript === undefined ? {} : { setupScript }) } });
describe("repository setup contract", () => {
  it.each(["fixture-setup/setup.sh", "setup script's copy.sh", "ci/準備.sh"])("keeps the explicit path %s in both config mirrors and recipe round trips", setupScript => {
    const input = frame(setupScript);
    expect(protocol.parse(input)).toEqual(input);
    expect(controlPlane.parse(input)).toEqual(input);
    const repository = { repository: "fixture/repo", setup: "echo recipe", setupScript };
    expect(CloudV2RepositoryDraftSchema.parse(repository)).toEqual(repository);
    const recipe = CloudV2RecipeSchema.parse({ repositories: [{ ...repository, commit: "a".repeat(40) }] });
    expect(editableRepositories(recipe)).toEqual([repository]);
  });
  it("retains the legacy config and recipe without opting into repository code", () => {
    expect(protocol.parse(frame())).toEqual(frame());
    expect(controlPlane.parse(frame())).toEqual(frame());
    expect(CloudV2RepositoryDraftSchema.parse({ repository: "fixture/repo", setup: "echo recipe" })).not.toHaveProperty("setupScript");
  });
  it.each(["", "/tmp/setup.sh", "../setup.sh", "ci/../setup.sh", "ci//setup.sh", "ci/./setup.sh", "ci/", "ci\\setup.sh",
    "C:/setup.sh", "setup\u0000.sh", "setup\n.sh", "setup\u0085.sh", "setup\u2028.sh", "setup\u202e.sh", ".git/hooks/setup.sh", ".zeros/setup.sh", ".context/setup.sh", ".claude/setup.sh", ".env.local", "x".repeat(513), null, 7])("refuses invalid or private setup selection %j", setupScript => {
    expect(protocol.safeParse(frame(setupScript)).success).toBe(false);
    expect(controlPlane.safeParse(frame(setupScript)).success).toBe(false);
    expect(CloudV2RepositoryDraftSchema.safeParse({ repository: "fixture/repo", setupScript }).success).toBe(false);
  });
});
