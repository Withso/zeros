import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudV2Build, CloudV2Computer } from "../../../platform/cloud-v2";

const state = vi.hoisted(() => ({
  role: "owner" as string,
  data: undefined as CloudV2Computer | undefined,
}));
vi.mock("../../team/team-store", () => ({
  getOrganizationStoreGeneration: () => 0,
  getTeamStoreState: () => ({ me: null }),
  useActiveOrganization: () => ({ id: "11111111-1111-4111-8111-111111111111", isPersonal: false, role: state.role }),
  useTeams: () => ({ me: { user: { id: "22222222-2222-4222-8222-222222222222" } } }),
}));
vi.mock("../../../state/use-cached-read", () => ({
  useCachedRead: () => ({ data: state.data, error: null, loading: false, refresh: () => {} }),
}));
vi.mock("../cloud-repository-chooser", () => ({ CloudRepositoryChooser: () => null }));

import { CloudRepositoryPanel, type CloudRepositoryTab } from "../cloud-repository-panel";

function build(patch: Partial<CloudV2Build> = {}): CloudV2Build {
  return {
    id: "00000000-0000-4000-8000-000000000005", organizationId: "11111111-1111-4111-8111-111111111111", version: 5,
    recipe: { repositories: [{ repository: "fixture/repo", commit: "a".repeat(40), branch: "main" }] },
    state: "succeeded", snapshotId: null, errorCode: null, createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), ...patch,
  };
}
const render = (tab: CloudRepositoryTab, repository = "fixture/repo") => renderToStaticMarkup(createElement(CloudRepositoryPanel,
  { repository, tab, onTabChange: () => {}, onOpenComputer: () => {} }));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

beforeEach(() => {
  state.role = "owner";
  const builds = [build()];
  state.data = { activeBuildId: builds[0]!.id, snapshotName: "zeros-alpha-x-v5", builds,
    recipe: { repositories: [{ repository: "fixture/repo", setup: "pnpm install", setupScript: "scripts/bootstrap.sh" }] }, recipeRevision: 3 };
});

describe("Cloud Computer repository settings", () => {
  it("offers only Git and Environment, with the branch on Git and its live branch as the hint", () => {
    const html = render("git");
    expect(text(html)).toMatch(/Git Environment/);
    expect(text(html)).not.toMatch(/Actions|Files|Paths/);
    expect(html).toContain('placeholder="Branch or tag (default: main)"');
  });

  it("keeps the setup command and workspace script on Environment", () => {
    const html = render("environment");
    expect(html).toContain('aria-label="fixture/repo workspace setup script"');
    expect(html).toContain('value="scripts/bootstrap.sh"');
    expect(text(html)).toContain("Tracked Bash script, relative to the repository");
  });

  it("explains a repository that left the Cloud Computer", () => {
    expect(text(render("git", "fixture/other"))).toContain("This repository is no longer on the Cloud Computer.");
  });

  it("keeps repository settings to owners and admins", () => {
    state.role = "member";
    const html = text(render("environment"));
    expect(html).toContain("Only owners and admins manage it.");
    expect(html).not.toContain("workspace setup script");
  });
});
