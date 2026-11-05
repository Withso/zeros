import { beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ values: new Map<string, unknown>(), notify: () => {}, user: "account", organizations: ["a", "b"] }));
vi.mock("../../../platform/settings", () => ({ getSetting: (key: string, fallback: unknown) => f.values.get(key) ?? fallback,
  setSetting: (key: string, value: unknown) => f.values.set(key, value) }));
vi.mock("../../team/control-plane", () => ({ CONTROL_PLANE_URL: "https://control.example.test" }));
vi.mock("../../team/team-store", () => ({ subscribeOrganizationSnapshots: (fn: () => void) => { f.notify = fn; return () => {}; },
  getTeamStoreState: () => ({ me: { user: { id: f.user }, organizations: f.organizations.map(id => ({ id, isPersonal: false })) } }) }));
import { readEnvironmentSelection, saveEnvironmentSelection } from "../environment-selection";
const repository = { id: "123", owner: "fixture", name: "repo", defaultBranch: "main", private: true, canPush: true };
beforeEach(() => { f.values.clear(); f.user = "account"; f.organizations = ["a", "b"]; });
it("restores scope and repository synchronously for A → B → A without crossing accounts", () => {
  saveEnvironmentSelection("account", "a", { scope: "cloud", repository });
  saveEnvironmentSelection("account", "b", { scope: "local", repository: null });
  expect(readEnvironmentSelection("account", "a")).toMatchObject({ scope: "cloud", repository });
  expect(readEnvironmentSelection("account", "b")).toMatchObject({ scope: "local", repository: null });
  expect(readEnvironmentSelection("other", "a")).toEqual({ scope: "local", repository: null });
});
it("prunes confirmed removed organizations while retaining other account navigation", () => {
  for (const user of ["account", "other"]) saveEnvironmentSelection(user, "a", { scope: "cloud", repository });
  f.organizations = ["b"]; f.notify();
  expect(readEnvironmentSelection("account", "a").repository).toBeNull();
  expect(readEnvironmentSelection("other", "a").repository).toEqual(repository);
});
it("bounds retained scopes and strips fields beyond repository navigation metadata", () => {
  for (let i = 0; i < 40; i++) saveEnvironmentSelection("account", String(i), { scope: "cloud", repository });
  expect(readEnvironmentSelection("account", "0").repository).toBeNull();
  expect(readEnvironmentSelection("account", "39").repository).toEqual(repository);
  saveEnvironmentSelection("account", "a", { scope: "cloud", repository: { ...repository, secret: "synthetic-canary" } } as never);
  expect(JSON.stringify([...f.values.values()]).includes("synthetic-canary")).toBe(false);
});
