import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import multiOrganizationFixture from "../../../../../../../scripts/__tests__/fixtures/organization-list.json";

const io = vi.hoisted(() => ({
  fetch: vi.fn(), open: null as ((open: boolean) => void) | null,
  auth: { status: "authenticated", storedUser: { sub: "account-a", provider: "workos" }, email: "a@example.test", startBrowserSignIn: vi.fn(), signOut: vi.fn(),
    accounts: [] as { accountId: string; email: string; name: string | null; active: boolean }[],
    refreshAccounts: vi.fn(async () => {}), switchAccount: vi.fn(), cancelPendingOAuth: vi.fn() },
}));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useEffect: () => {},
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));
vi.mock("../../auth", () => ({ useAuth: () => io.auth }));
vi.mock("../../auth/auth-store", () => ({ getSession: async () => ({ access_token: "fixture-session" }) }));
vi.mock("../../update/control-plane-fetch", () => ({ controlPlaneFetch: io.fetch }));
vi.mock("../team-sync", () => ({ requestTeamResync: vi.fn() }));
vi.mock("@radix-ui/react-dropdown-menu", async () => {
  const React = await import("react");
  type Props = { children?: ReactNode; className?: string; onOpenChange?: (open: boolean) => void; "aria-current"?: string };
  const surface = React.forwardRef<HTMLDivElement, Props>(({ children, className }, ref) => React.createElement("div", { ref, className }, children));
  const item = React.forwardRef<HTMLDivElement, Props>((props, ref) => React.createElement("div", { role: "menuitem", "aria-current": props["aria-current"], className: props.className, ref }, props.children));
  return {
    Root: (props: Props) => { io.open = props.onOpenChange ?? null; return React.createElement("div", null, props.children); },
    Content: surface, SubContent: surface, Portal: surface, Trigger: surface, Group: surface, Label: surface, Separator: surface,
    Item: item, Sub: surface, SubTrigger: surface, RadioGroup: surface, CheckboxItem: item, RadioItem: item, ItemIndicator: surface,
  };
});

const organizations = multiOrganizationFixture;
const response = { user: { id: "account-a", email: "a@example.test", displayName: null, staffRole: null }, organizations, teams: organizations };
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  io.auth.status = "authenticated";
  io.auth.accounts = [];
  vi.stubEnv("VITE_CONTROL_PLANE_URL", "https://api.example.test");
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function menuRows(markup: string) {
  const rows: { name: string; active: boolean }[] = [];
  const text = (node: DefaultTreeAdapterTypes.Node): string => "value" in node ? node.value : "childNodes" in node ? node.childNodes.map(text).join("") : "";
  const visit = (node: DefaultTreeAdapterTypes.Node) => {
    if ("attrs" in node && node.attrs.some(attr => attr.name === "role" && attr.value === "menuitem"))
      rows.push({ name: text(node), active: node.attrs.some(attr => attr.name === "aria-current" && attr.value === "true") });
    if ("childNodes" in node) node.childNodes.forEach(visit);
  };
  visit(parseFragment(markup));
  return rows;
}

async function setup() {
  const { bindAccountPresentationOwner, accountPresentationOwner } = await import("../../../platform/account-presentation-cache");
  bindAccountPresentationOwner(accountPresentationOwner("https://api.example.test", "account-a"));
  const store = await import("../team-store"), selection = await import("../active-team");
  io.fetch.mockImplementation(() => Promise.resolve(Response.json(response)));
  await store.refreshTeams();
  selection.setActiveOrganizationSelection(organizations[18]!.id, false);
  const { OrganizationSwitcher } = await import("../organization-switcher");
  return { store, render: () => renderToStaticMarkup(createElement(OrganizationSwitcher)) };
}

it("normalizes /v1/me through the store into every rendered switcher row with stable order and the active check", async () => {
  const { store, render } = await setup();
  expect(io.fetch.mock.calls[0]?.[0]).toBe("https://api.example.test/v1/me");
  expect(store.getTeamStoreState().me?.organizations).toEqual(organizations);
  const markup = render(), rows = menuRows(markup);
  expect(rows.slice(0, 21).map(row => row.name)).toEqual(["Local", ...organizations.map(org => org.name)]);
  expect(rows.filter(row => row.active)).toEqual([{ name: "Membership 19", active: true }]);
  expect(markup).toContain("overflow-y-auto");
  expect(markup).toContain("max-h-(--radix-dropdown-menu-content-available-height)");
});

it("opening retains the same rows and selection through a shared pending refresh and a failure", async () => {
  const { store, render } = await setup();
  const before = render(), snapshot = store.getTeamStoreState().me;
  let fail!: (reason: Error) => void;
  io.fetch.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
  io.open!(true);
  const pending = store.refreshTeams();
  expect(store.refreshTeams()).toBe(pending);
  await Promise.resolve();
  expect(store.getTeamStoreState().me).toBe(snapshot);
  expect(menuRows(render())).toEqual(menuRows(before));
  fail(new Error("offline")); await pending;
  expect(menuRows(render())).toEqual(menuRows(before));
});

it("renders the full cached list and selected organization offline without granting server capabilities", async () => {
  await setup();
  vi.resetModules();
  io.auth.status = "unauthenticated";
  const account = await import("../../../platform/account-presentation-cache");
  account.bindAccountPresentationOwner(account.accountPresentationOwner("https://api.example.test", "account-a"));
  const store = await import("../team-store");
  store.restoreOrganizationPresentation();
  const { OrganizationSwitcher } = await import("../organization-switcher");
  const markup = renderToStaticMarkup(createElement(OrganizationSwitcher));
  expect(menuRows(markup).slice(0, 21).map(row => row.name)).toEqual(["Local", ...organizations.map(org => org.name)]);
  expect(menuRows(markup).filter(row => row.active)).toEqual([{ name: "Membership 19", active: true }]);
  expect(store.getTeamStoreState().me).toBeNull();
  expect(markup).not.toContain("Manage organization");
  expect(markup).not.toContain("Create organization");
});

it("lists other signed-in accounts to switch to and always offers to add one", async () => {
  const { render } = await setup();
  io.auth.accounts = [
    { accountId: "account-a", email: "a@example.test", name: null, active: true },
    { accountId: "account-b", email: "b@example.test", name: null, active: false },
  ];
  const markup = render(), names = menuRows(markup).map(row => row.name);
  expect(markup).toContain("Switch account");
  expect(names).toContain("b@example.test");
  expect(names).not.toContain("a@example.test");
  expect(names).toContain("Add account");
  io.open!(true);
  expect(io.auth.refreshAccounts).toHaveBeenCalled();

  io.auth.accounts = [{ accountId: "account-a", email: "a@example.test", name: null, active: true }];
  const alone = render();
  expect(alone).not.toContain("Switch account");
  expect(menuRows(alone).map(row => row.name)).toContain("Add account");
});
