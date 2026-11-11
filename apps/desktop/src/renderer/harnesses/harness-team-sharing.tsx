// Team sharing phase 1 with production components and synthetic data: Home's
// By filter, the sidebar's Team list, and a teammate's workspace as a reader
// (header presence, Follow, Pin and the read-only bar). The smoke intercepts
// every control-plane route; nothing here reaches a real service.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";

const me = "11111111-1111-4111-8111-111111111111", organizationId = "22222222-2222-4222-8222-222222222222";
const alex = "44444444-4444-4444-8444-444444444444", sam = "55555555-5555-4555-8555-555555555555";
const workspaceId = "33333333-3333-4333-8333-333333333333";
const params = new URLSearchParams(location.search);
const homeOpens: number[] = [];
(window as unknown as { __teamSharingFixture: { homeOpens(): number } }).__teamSharingFixture = { homeOpens: () => homeOpens.length };
window.__ZEROS_NATIVE__ = {
  on: () => () => {},
  async invoke<T>(command: string): Promise<T> {
    if (command === "auth_get_access_token") return { access_token: "synthetic-team-sharing-session" } as T;
    if (command === "auth_get_session_user") return { sub: me, accountId: me, email: "fixture@example.test", name: "Fixture", provider: "workos" } as T;
    return null as T;
  },
};

async function main() {
  const React = await import("react"), { createRoot } = await import("react-dom/client");
  const { TooltipProvider } = await import("../shared/ui/primitives");
  const { acceptOrganizationSnapshot } = await import("../features/team/team-store");
  const { recordOrganizationSharing } = await import("../platform/team-sharing-state");
  const { cloudV2Document, CloudV2WorkspaceSchema } = await import("../platform/cloud-v2");
  const { restoreCloudWorkspaceCatalog, cloudWorkspaceDocument, subscribeCloudWorkspaces } = await import("../state/cloud-workspace-catalog");
  const { DashboardToolbar } = await import("../features/dashboard/dashboard-toolbar");
  const { useDashboardByState, useDashboardPreferences } = await import("../features/dashboard/preferences");
  const { useOrganizationRoster } = await import("../state/organization-roster");
  const { SidebarTeamSection } = await import("../shell/sidebar-team-section");
  const { WorkspaceHeaderView } = await import("../shell/conversation/workspace-header");
  const { TeamSharingHeaderControls } = await import("../shell/conversation/team-sharing-header-controls");
  const { TeamSharingReadOnlyBar } = await import("../shell/team-sharing-read-only-bar");
  const { WorkspaceIdentityLabel } = await import("../shell/conversation/workspace-identity");

  const membership = [{ id: organizationId, slug: "fixture", name: "Organization A", logo: null, role: "member" as const, isPersonal: false, defaultTeamId: null,
    workspaceCapabilities: { local: true, cloud: true }, teamCapabilities: { multiple: false as const, canCreate: false as const } }];
  acceptOrganizationSnapshot({ user: { id: me, email: "fixture@example.test", displayName: "Fixture", staffRole: null }, organizations: membership, teams: membership });
  recordOrganizationSharing(organizationId, true);
  const doc = cloudV2Document(CloudV2WorkspaceSchema.parse({
    id: workspaceId, organizationId, creatorUserId: alex, name: "w-7", repository: "example/repo", branch: "zeros/w-7", baseBranch: "main",
    state: "running", errorCode: null, archivedAt: null, createdAt: new Date(Date.now() - 86_400_000).toISOString(), updatedAt: new Date().toISOString(), version: 2,
    capabilities: { design: false, browser: false, simulators: false, terminal: true, files: true, git: true, agents: ["codex"] },
    teamSharing: 1, createdByUserId: alex, viewerRole: "member", readOnly: true, canManage: false, following: false, pinned: false, followerIds: [sam], followerCount: 1,
  }));
  restoreCloudWorkspaceCatalog([doc]);
  const target = { organizationId, workspaceId };
  const rows = [{ title: "Your workspace", creator: me }, { title: "Alex's workspace", creator: alex }, { title: "Sam's workspace", creator: sam }];

  function Home() {
    const preferences = useDashboardPreferences();
    const [by, setBy] = useDashboardByState(organizationId);
    const roster = useOrganizationRoster(organizationId, true);
    const people = (roster ?? []).filter(member => member.id !== me);
    const person = by === "me" ? me : by.startsWith("user:") ? by.slice(5) : null;
    return <section aria-label="Home" className="flex flex-col gap-2">
      <DashboardToolbar preferences={preferences} query="" onQueryChange={() => {}} active by={{ value: by, onChange: setBy, people }} />
      <ul aria-label="Workspaces" className="text-fg1 px-6 text-sm">
        {rows.filter(row => !person || row.creator === person).map(row => <li key={row.title}>{row.title}</li>)}
      </ul>
    </section>;
  }
  function Reader() {
    const read = () => cloudWorkspaceDocument(target);
    const workspace = React.useSyncExternalStore(subscribeCloudWorkspaces, read, read);
    if (!workspace) return null;
    return <section aria-label="Reader" className="bg-bg1 flex w-[720px] flex-col">
      <WorkspaceHeaderView readOnly identity={<WorkspaceIdentityLabel name="w-7" title="Fix login" placement="cloud" />}
        sharing={<TeamSharingHeaderControls target={target} workspace={workspace} active />} />
      <TeamSharingReadOnlyBar folder={`cloud://${organizationId}/${workspaceId}`} surfaceActive />
    </section>;
  }
  function Harness() {
    return <main className="bg-bg1 flex min-h-screen gap-6 p-6">
      <nav aria-label="Workspace navigation" className="bg-bg1 w-60 shrink-0">
        <SidebarTeamSection organizationId={organizationId} me={me} active homeActive onHome={() => homeOpens.push(Date.now())}
          entryClassName="flex h-8 w-full min-w-0 items-center justify-start gap-2 rounded-md px-2 text-left text-xs text-fg2 hover:bg-(--surface-hover) data-[state=active]:bg-bg2-highlight data-[state=active]:text-fg1"
          labelClassName="select-none truncate text-3xxs leading-4 font-medium text-fg3" />
      </nav>
      <div className="flex min-w-0 flex-1 flex-col gap-6">
        {params.get("view") !== "reader" && <Home />}
        <Reader />
      </div>
    </main>;
  }
  document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark";
  createRoot(document.getElementById("root")!).render(<React.StrictMode><TooltipProvider><Harness /></TooltipProvider></React.StrictMode>);
}
void main();
