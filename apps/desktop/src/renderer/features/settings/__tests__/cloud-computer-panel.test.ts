import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudV2Build, CloudV2Computer } from "../../../platform/cloud-v2";

const state = vi.hoisted(() => ({
  role: "owner" as string,
  data: undefined as CloudV2Computer | undefined,
}));
vi.mock("../../team/team-store", () => ({
  useActiveOrganization: () => ({ id: "11111111-1111-4111-8111-111111111111", isPersonal: false, role: state.role }),
  useTeams: () => ({ me: { user: { id: "22222222-2222-4222-8222-222222222222" } } }),
}));
vi.mock("../../../state/use-cached-read", () => ({
  useCachedRead: () => ({ data: state.data, error: null, loading: false, refresh: () => {} }),
}));
vi.mock("../cloud-repository-picker", () => ({
  CloudRepositoryPicker: ({ label }: { label?: string }) => createElement("span", { "data-picker": "" }, label),
}));

import { CloudComputerPanel } from "../cloud-computer-panel";

const day = 86_400_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
function build(version: number, patch: Partial<CloudV2Build> = {}): CloudV2Build {
  return {
    id: `00000000-0000-4000-8000-${String(version).padStart(12, "0")}`, organizationId: "11111111-1111-4111-8111-111111111111",
    version, recipe: { repositories: [{ repository: "iamarunrk/0kit", commit: "a".repeat(40), branch: "main" }] },
    state: "succeeded", snapshotId: null, errorCode: null, createdAt: ago(13 * day), startedAt: ago(13 * day), finishedAt: ago(13 * day),
    ...patch,
  };
}
const render = () => renderToStaticMarkup(createElement(CloudComputerPanel));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

beforeEach(() => {
  state.role = "owner";
  const builds = [build(5), build(4, { createdAt: ago(14 * day), finishedAt: ago(14 * day) })];
  state.data = { activeBuildId: builds[0]!.id, snapshotName: "zeros-alpha-x-v5", builds,
    recipe: { repositories: [{ repository: "iamarunrk/0kit" }] }, recipeRevision: 3 };
});

describe("Cloud Computer settings panel", () => {
  it("shows the last build, a Build computer action and the build history", () => {
    const html = text(render());
    expect(html).toContain("Last build 13d ago");
    expect(html).toContain("Build computer");
    expect(html).toContain("History (2)");
    expect(html).not.toContain("Unbuilt changes");
    expect(html).not.toContain("Discard");
    // The installed repository is listed as configured, with its live branch as the hint.
    expect(html).toContain("iamarunrk/0kit");
    expect(render()).toContain('placeholder="Branch or tag (default: main)"');
  });

  it("keeps the installed repository beside an added one and reports the unbuilt change", () => {
    state.data = { ...state.data!, recipe: { repositories: [{ repository: "iamarunrk/0kit" }, { repository: "withso/zeros-dev-fixture" }] }, recipeRevision: 4 };
    const html = text(render());
    expect(html).toContain("Unbuilt changes");
    expect(html).toContain("Changed: repositories");
    expect(html).toContain("Discard");
    expect(html).toContain("iamarunrk/0kit");
    expect(html).toContain("withso/zeros-dev-fixture");
    expect(html).toContain("Add or remove repositories");
  });

  it("shows a removal as unbuilt until the computer is built again", () => {
    state.data = { ...state.data!, recipe: { repositories: [] }, recipeRevision: 4 };
    const html = text(render());
    expect(html).toContain("Changed: repositories");
    expect(html).not.toContain("Remove iamarunrk/0kit");
    expect(render()).toMatch(/<button[^>]*disabled=""[^>]*>Build computer<\/button>/);
  });

  it("reports a running build and locks the controls", () => {
    state.data = { ...state.data!, builds: [build(6, { state: "building", finishedAt: null }), ...state.data!.builds] };
    const html = render();
    expect(text(html)).toContain("Building computer…");
    expect(text(html)).toContain("Build #6");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Building…<\/button>/);
  });

  it("falls back to the live build's repositories on an older control plane", () => {
    state.data = { activeBuildId: state.data!.activeBuildId, snapshotName: null, builds: state.data!.builds };
    const html = text(render());
    expect(html).toContain("Last build 13d ago");
    expect(html).toContain("iamarunrk/0kit");
  });

  it("keeps Computer administration to owners and admins", () => {
    state.role = "member";
    const html = text(render());
    expect(html).toContain("Only organization owners and admins manage the Cloud Computer.");
    expect(html).not.toContain("Build computer");
  });
});
