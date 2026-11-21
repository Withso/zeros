import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ allowed: true, personal: false, member: true, scope: "cloud", user: "owner", epoch: 1,
  organization: "11111111-1111-4111-8111-111111111111", read: vi.fn(), local: vi.fn(),
  data: { repositoryId: "123", revision: 1, versionId: "22222222-2222-4222-8222-222222222222", updatedAt: null,
    variables: [{ name: "APP_SECRET", bytes: 30 }], files: [{ path: "config/.env.local", bytes: 40 }] } }));
vi.mock("../../../config/release-channel", () => ({ isFeatureEnabled: () => f.allowed }));
vi.mock("../../team/team-store", () => ({
  useActiveOrganization: () => ({ id: f.organization, isPersonal: f.personal }),
  useTeams: () => ({ me: { user: { id: f.user }, organizations: f.member ? [{ id: f.organization, workspaceCapabilities: { cloud: true } }] : [] } }),
  getOrganizationStoreGeneration: () => f.epoch,
}));
vi.mock("../../repositories/repositories-panel", () => ({ UserEnvironmentPanel: (props: { ownerOrganizationId?: string }) => { f.local(props.ownerOrganizationId); return "Local environment vault"; } }));
vi.mock("../cloud-environment-api", () => ({ cloudEnvironmentCache: {}, cloudEnvironmentKey: () => "scope",
  readCloudEnvironment: vi.fn(), saveCloudEnvironment: vi.fn(), saveCloudEnvironmentFile: vi.fn(), cloudEnvironmentError: () => "Unavailable" }));
vi.mock("../environment-selection", () => ({
  readEnvironmentSelection: () => ({ scope: f.scope, repository: { id: "123", owner: "fixture", name: "repo", defaultBranch: "main", canPush: true, private: true } }),
  saveEnvironmentSelection: vi.fn(),
}));
vi.mock("../cloud-repository-picker", () => ({ CloudRepositoryPicker: () => "Choose repository" }));
vi.mock("../../../state/use-recovering-read", () => ({ useRecoveringRead: () => { f.read(); return { data: f.data, loading: false, error: null, readError: null, refresh() {} }; } }));

import { EnvironmentPanel } from "../environment-panel";
const render = (unified: boolean) => renderToStaticMarkup(createElement(EnvironmentPanel, { surfaceActive: true, unified }));
beforeEach(() => { f.allowed = true; f.personal = false; f.member = true; f.scope = "local"; vi.clearAllMocks(); });

it("resolves the old rail's Local list for the selected organization, as before", () => {
  render(false);
  expect(f.local).toHaveBeenCalledWith(f.organization);
});
it("keeps the unified rail's Local list Personal", () => {
  render(true);
  expect(f.local).toHaveBeenCalledWith(undefined);
});
it("keeps Personal's Local list Personal in the old rail", () => {
  f.personal = true;
  render(false);
  expect(f.local).toHaveBeenCalledWith(undefined);
});
