import { describe, expect, it, vi } from "vitest";
vi.mock("../../config/release-channel", async (original) => ({
  ...(await original<typeof import("../../config/release-channel")>()),
  isFeatureEnabled: () => true,
}));
import type { Workspace } from "../../platform/git";
import type { Project } from "../projects-store";
import { projectGroupLookup } from "../project-identity";
import { dashboardRowBuilder } from "../../features/dashboard/dashboard-model";
import { workspacePaletteEntries } from "../../shell/command-palette-model";

const local: Project = { id: "local-zeros", name: "Zeros", repoRoot: "/repos/zeros", repoSlug: "zeros",
  originUrl: "git@github.com:withso/zeros.git", isGitRepository: true, addedAt: 1 };
const cloud: Project = { id: "cloud-repository:org:github.com:withso/zeros", name: "zeros",
  repoRoot: "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222",
  repoSlug: "cloud-org:github.com:withso/zeros", originUrl: "https://github.com/withso/zeros.git", isGitRepository: true, addedAt: 2 };
const cloudRow = {
  id: cloud.repoRoot, path: cloud.repoRoot, repoRoot: cloud.repoRoot, repoSlug: cloud.repoSlug, branch: "zeros/x", baseBranch: "main",
  status: "in-progress", createdAt: 1, archivedAt: null, stashRef: null, prNumber: null, prState: null, prUrl: null,
  agentId: null, lastActiveAt: null, placement: "cloud", organizationId: "11111111-1111-4111-8111-111111111111",
} as Workspace;

describe("lists name one repository once", () => {
  const projects = [local, cloud];
  it("Dashboard reads a cloud row as its joined project's default folder", () => {
    expect(dashboardRowBuilder(projects, [], new Map(), projectGroupLookup(projects))(cloudRow)).toMatchObject({ project: local, repoName: "Zeros" });
    expect(dashboardRowBuilder(projects, [], new Map())(cloudRow)).toMatchObject({ project: cloud, repoName: "zeros" });
  });

  it("the palette names a cloud row by the same project", () => {
    expect(workspacePaletteEntries([cloudRow], projects, "all", projectGroupLookup(projects))[0].detail).toContain("Zeros");
    expect(workspacePaletteEntries([cloudRow], projects, "all")[0].detail).toContain("zeros");
  });
});
