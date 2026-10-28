import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useLayoutEffect: () => {} }));
vi.mock("../team-store", () => ({
  useTeams: () => ({ me: null, status: "error", error: "temporary organization read failure", reload: async () => null }),
  useActiveTeam: () => null, getOrganizationStoreGeneration: () => 1,
}));
vi.mock("../control-plane", async original => ({
  ...await original<typeof import("../control-plane")>(), CONTROL_PLANE_URL: "https://control-plane.example",
}));
import { TeamPanel } from "../team-panel";
import { MembersPanel } from "../members-panel";
it.each([
  { label: "team settings", component: TeamPanel },
  { label: "members", component: MembersPanel },
])("does not paint a transient account read in $label", ({ component }) => {
  const html = renderToStaticMarkup(createElement(component));
  expect(html).not.toContain("temporary organization read failure");
  expect(html).toContain('aria-busy="true"');
});
