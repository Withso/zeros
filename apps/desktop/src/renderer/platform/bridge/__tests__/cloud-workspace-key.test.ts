import { describe, expect, it } from "vitest";
import {
  cloudScopedId,
  cloudTargetForValue,
  cloudWorkspaceKey,
  parseCloudScopedId,
  parseCloudWorkspaceKey,
} from "../cloud-workspace-key";

const target = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
};

describe("cloud workspace UI identity", () => {
  it("isolates the same native conversation in different workspaces", () => {
    const other = {
      ...target,
      workspaceId: "33333333-3333-4333-8333-333333333333",
    };
    expect(cloudScopedId(target, "chat/same:%")).not.toBe(
      cloudScopedId(other, "chat/same:%"),
    );
    expect(parseCloudScopedId(cloudScopedId(target, "chat/same:%"))).toEqual({
      ...target,
      id: "chat/same:%",
    });
  });

  it("keeps a stable owner while navigating a checkout subdirectory", () => {
    expect(
      parseCloudWorkspaceKey(`${cloudWorkspaceKey(target)}/packages/app`),
    ).toEqual({ ...target, relativePath: "packages/app" });
    expect(cloudTargetForValue("/workspace/repo")).toBeNull();
    expect(cloudTargetForValue("local-main")).toBeNull();
  });

  it("rejects traversal and malformed cloud references instead of routing locally", () => {
    expect(() => cloudTargetForValue("cloud://bad/workspace")).toThrow();
    expect(() => cloudTargetForValue("CLOUD://bad/workspace")).toThrow();
    expect(() =>
      cloudWorkspaceKey({
        ...target,
        workspaceId: `${target.workspaceId}/other`,
      }),
    ).toThrow();
    expect(() =>
      parseCloudWorkspaceKey(`${cloudWorkspaceKey(target)}/../local`),
    ).toThrow();
    expect(() =>
      parseCloudScopedId(
        `cloud:${target.organizationId}:${target.workspaceId}:%`,
      ),
    ).toThrow();
  });
});
