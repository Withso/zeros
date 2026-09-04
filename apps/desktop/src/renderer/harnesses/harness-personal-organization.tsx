// Development-only UI regression harness, never imported by the shipped app.
// Uses the real switcher/store/filter with synthetic account snapshots. It does
// not authenticate, contact WorkOS, create worktrees, or change server data.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import React, { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AuthContext,
  type AuthContextValue,
} from "../features/auth/auth-context";
import { OrganizationSwitcher } from "../features/team/organization-switcher";
import {
  acceptOrganizationSnapshot,
  clearTeamStore,
  getActiveOrganizationIdSnapshot,
  getActiveOrganizationSnapshot,
  useActiveOrganization,
} from "../features/team/team-store";
import {
  canCreateWorkspaceIn,
  filterRowsForOrganization,
  localWorkspaceOwner,
} from "../features/team/organization-capabilities";
import {
  controlPlane,
  type Me,
  type OrganizationSummary,
} from "../features/team/control-plane";
import { Button } from "../shared/ui/primitives/button";
import { TooltipProvider } from "../shared/ui/primitives/tooltip";

type LocalRow = {
  id: string;
  organizationId: string | null;
  placement: "local" | "cloud";
};
const initialRows: LocalRow[] = [
  { id: "Unowned local", organizationId: null, placement: "local" },
  { id: "A legacy local", organizationId: "personal_a", placement: "local" },
  { id: "B legacy local", organizationId: "personal_b", placement: "local" },
  { id: "Business A cloud", organizationId: "org_a", placement: "cloud" },
  { id: "Business B cloud", organizationId: "org_b", placement: "cloud" },
];

function account(id: string): Me {
  const summary = (personal: boolean): OrganizationSummary => ({
    id: `${personal ? "personal" : "org"}_${id}`,
    slug: `${personal ? "personal" : "org"}_${id}`,
    name: personal
      ? `Account ${id.toUpperCase()}`
      : `Business ${id.toUpperCase()}`,
    logo: null,
    isPersonal: personal,
    role: "owner",
    defaultTeamId: null,
    workspaceCapabilities: { local: true, cloud: !personal },
    teamCapabilities: { multiple: false, canCreate: false },
  });
  const organizations = [summary(true), summary(false)];
  return {
    user: { id, email: `${id}@example.test`, displayName: id, staffRole: null },
    organizations,
    teams: organizations,
  };
}

// A refresh stays offline; fixture selection publishes only explicit snapshots.
controlPlane.me = async () => {
  throw new Error("Harness organization service offline");
};
window.__ZEROS_NATIVE__ = {
  async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    if (command === "shell_open_url") {
      document.getElementById("dashboard-link")!.textContent = String(
        args?.url ?? "",
      );
      return null as T;
    }
    throw new Error(`Personal harness received unexpected command: ${command}`);
  },
  on: () => () => {},
};

function Workspaces() {
  const active = useActiveOrganization();
  const [rows, setRows] = useState(initialRows);
  // Match production list memoization: aliases must invalidate the active
  // scope snapshot before any engine write or workspace-list fetch succeeds.
  const visible = useMemo(
    () => filterRowsForOrganization(rows, active),
    [rows, active],
  );
  return (
    <section className="flex flex-col gap-3">
      <output data-testid="cloud-capability">
        {canCreateWorkspaceIn(active, "cloud") ? "allowed" : "blocked"}
      </output>
      <Button
        onClick={() => {
          const owner = localWorkspaceOwner(
            getActiveOrganizationSnapshot(),
            getActiveOrganizationIdSnapshot(),
          );
          setRows((previous) => [
            ...previous,
            { id: "Created local", ...owner },
          ]);
        }}
      >
        Create local fixture
      </Button>
      <ul aria-label="Visible workspaces">
        {visible.map((row) => (
          <li key={row.id} data-owner={row.organizationId ?? "none"}>
            {row.id}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Harness() {
  const [user, setUser] = useState<string | null>(null);
  const selectAccount = (id: string | null) => {
    clearTeamStore({ resetSelection: true });
    if (id) acceptOrganizationSnapshot(account(id));
    setUser(id);
  };
  const auth: AuthContextValue = {
    status: user ? "authenticated" : "unauthenticated",
    session: null,
    userId: user,
    email: user ? `${user}@example.test` : null,
    startBrowserSignIn: async () => ({ ok: false }),
    oauthError: null,
    clearOAuthError: () => {},
    cancelPendingOAuth: () => {},
    signOut: async () => selectAccount(null),
    signOutEverywhere: async () => selectAccount(null),
  };
  return (
    <AuthContext.Provider value={auth}>
      <TooltipProvider>
        <main className="bg-bg1 text-fg1 flex min-h-screen flex-col gap-4 p-10">
          <div className="flex gap-2">
            <Button onClick={() => selectAccount("a")}>Use account A</Button>
            <Button onClick={() => selectAccount("b")}>Use account B</Button>
          </div>
          <div className="w-64">
            <OrganizationSwitcher />
          </div>
          <Workspaces />
          <output id="dashboard-link" />
        </main>
      </TooltipProvider>
    </AuthContext.Provider>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
