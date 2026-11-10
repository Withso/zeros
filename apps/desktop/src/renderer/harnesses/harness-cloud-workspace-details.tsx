// Production details card and settings row with synthetic data. The details
// card sits in the real popover; the setting talks to an intercepted API.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";

const userId = "11111111-1111-4111-8111-111111111111", organizationId = "22222222-2222-4222-8222-222222222222";
const params = new URLSearchParams(location.search);
const calls: string[] = [];
(window as unknown as { __detailsFixture: { calls(): string[] } }).__detailsFixture = { calls: () => [...calls] };
window.__ZEROS_NATIVE__ = {
  on: () => () => {},
  async invoke<T>(command: string): Promise<T> {
    if (command === "auth_get_access_token") return { access_token: "synthetic-details-session" } as T;
    if (command === "auth_get_session_user") return { sub: userId, accountId: userId, email: "fixture@example.test", name: "Fixture", provider: "workos" } as T;
    return null as T;
  },
};

async function main() {
  const React = await import("react"), { createRoot } = await import("react-dom/client");
  const { TooltipProvider } = await import("../shared/ui/primitives");
  const { Popover, PopoverAnchor, PopoverContent } = await import("../shared/ui/primitives/popover");
  const { CloudWorkspaceDetailsCard } = await import("../shell/conversation/cloud-workspace-details");
  const { WorkspaceApiAccessSetting } = await import("../features/settings/workspace-api-access-setting");
  const { acceptOrganizationSnapshot } = await import("../features/team/team-store");
  const membership = [{ id: organizationId, slug: "fixture", name: "Organization A", logo: null, role: "owner" as const, isPersonal: false, defaultTeamId: null,
    workspaceCapabilities: { local: true, cloud: true }, teamCapabilities: { multiple: false as const, canCreate: false as const } }];
  acceptOrganizationSnapshot({ user: { id: userId, email: "fixture@example.test", displayName: "Fixture", staffRole: null }, organizations: membership, teams: membership });
  const running = params.get("state") !== "stopped";
  const workspace = {
    id: "33333333-3333-4333-8333-333333333333", organizationId, name: "w-7", status: running ? "ready" : "stopped",
    createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    repository: { forge: "github.com", owner: "example", name: "repo", revision: "refs/heads/main" },
    capabilities: { canWrite: true, canManage: true, canStart: true, startUnavailableReason: null },
  } as unknown as import("../platform/cloud-workspaces").CloudWorkspaceDocument;
  const resources = running ? { cpu: { cores: 4, usedPercent: 12 }, memory: { totalBytes: 8 * 2 ** 30, usedPercent: 50 },
    disk: { totalBytes: 64 * 2 ** 30, usedPercent: 10 }, sampledAt: Date.now() } : null;
  function Harness() {
    if (params.get("view") === "setting") return <main className="bg-bg1 min-h-screen p-8"><div className="mx-auto max-w-2xl">
      <WorkspaceApiAccessSetting organizationId={organizationId} surfaceActive /></div></main>;
    return <main className="bg-bg1 min-h-screen p-8">
      <Popover open>
        <PopoverAnchor asChild><span data-details-anchor="" className="inline-block size-1" /></PopoverAnchor>
        <PopoverContent align="start" sideOffset={6} className="w-[320px]" aria-label="Cloud workspace details">
          <CloudWorkspaceDetailsCard workspace={workspace} title="Fix login" statusLabel={running ? "Running" : "Stopped"} resources={resources}
            changing={false} onChange={operation => { calls.push(operation); }} />
        </PopoverContent>
      </Popover>
    </main>;
  }
  // After the imports: loading the app's theme module applies its own default.
  document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark";
  createRoot(document.getElementById("root")!).render(<React.StrictMode><TooltipProvider><Harness /></TooltipProvider></React.StrictMode>);
}
void main();
