// Production settings with synthetic identity and transport. Browser tests
// intercept the API; this harness never reads a device's environment vault.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";

const userId = "11111111-1111-4111-8111-111111111111";
let accountId = userId;
const computer = new URLSearchParams(location.search).has("computer");
const organizations = ["22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];
window.__ZEROS_NATIVE__ = {
  on: () => () => {},
  async invoke<T>(command: string): Promise<T> {
    if (command === "auth_get_access_token") return { access_token: `synthetic-environment-session-${accountId}` } as T;
    if (command === "auth_get_session_user") return { sub: accountId, accountId, email: "fixture@example.test", name: "Fixture", provider: "workos" } as T;
    return null as T;
  },
};

async function main() {
  const React = await import("react"), { createRoot } = await import("react-dom/client");
  const { Button, TooltipProvider } = await import("../shared/ui/primitives");
  const { EnvironmentPanel } = await import("../features/settings/environment-panel");
  const { CloudRepositoryPanel } = await import("../features/settings/cloud-repository-panel");
  const { acceptOrganizationSnapshot } = await import("../features/team/team-store");
  const { setActiveOrganizationSelection } = await import("../features/team/active-team");
  const { saveEnvironmentSelection } = await import("../features/settings/environment-selection");
  const { BridgeProvider } = await import("../platform/bridge/use-bridge");
  const { RuntimeClient } = await import("../platform/bridge/ws-client");
  const membership = organizations.map((id, i) => ({ id, slug: `fixture-${i}`, name: `Organization ${i ? "B" : "A"}`, logo: null,
    role: "owner" as const, isPersonal: false, defaultTeamId: null, workspaceCapabilities: { local: true, cloud: true },
    teamCapabilities: { multiple: false as const, canCreate: false as const } }));
  acceptOrganizationSnapshot({ user: { id: userId, email: "fixture@example.test", displayName: "Fixture", staffRole: null }, organizations: membership, teams: membership });
  function identity(next: string, role: "owner" | "member" = "owner", personal = false) {
    accountId = next;
    const rows = membership.map(row => ({ ...row, role, isPersonal: personal }));
    acceptOrganizationSnapshot({ user: { id: next, email: "fixture@example.test", displayName: "Fixture", staffRole: null }, organizations: rows, teams: rows });
    setActiveOrganizationSelection(organizations[0]!, personal);
  }
  setActiveOrganizationSelection(organizations[0]!, false);
  for (const [i, organization] of organizations.entries()) saveEnvironmentSelection(userId, organization, { scope: "cloud",
    repository: { id: i ? "456" : "123", owner: "fixture", name: i ? "second" : "first", defaultBranch: "main", private: true, canPush: true } });
  Object.defineProperty(RuntimeClient.prototype, "status", { get: () => "connected" });
  RuntimeClient.prototype.connect = () => Promise.resolve();
  RuntimeClient.prototype.request = async function <T extends import("@zeros/protocol/messages").BridgeMessage>(message: Partial<import("@zeros/protocol/messages").BridgeMessage> & { type: string }): Promise<T> {
    const request = message as { op?: string; requestId?: string };
    const result = request.op === "settings.resolve" ? { effective: {}, sources: {}, warnings: [] }
      : request.op === "settings.read" ? { doc: {}, text: "", exists: false, path: "/fixture/settings.local.toml" } : {};
    return { type: "WORKSPACE_RESPONSE", requestId: request.requestId ?? "fixture", result } as unknown as T;
  };
  function Harness() {
    const [active, setActive] = React.useState(true);
    return <TooltipProvider><BridgeProvider><main className="bg-bg1 min-h-screen p-8"><div className="mx-auto flex max-w-3xl flex-col gap-6">
      <nav aria-label="Environment fixture owners" className="flex gap-2">
        {organizations.map((id, i) => <Button key={id} variant="secondary" onClick={() => setActiveOrganizationSelection(id, false)}>Organization {i ? "B" : "A"}</Button>)}
        <Button variant="ghost" onClick={() => setActive(value => !value)}>{active ? "Hide settings" : "Show settings"}</Button>
        {computer && <>
          <Button variant="secondary" onClick={() => identity("55555555-5555-4555-8555-555555555555")}>Account B</Button>
          <Button variant="secondary" onClick={() => identity(userId)}>Account A</Button>
          <Button variant="secondary" onClick={() => identity(accountId, "member")}>Member</Button>
          <Button variant="secondary" onClick={() => identity(accountId, "owner", true)}>Local owner</Button>
        </>}
      </nav>
      {computer
        ? <CloudRepositoryPanel repository="fixture/repo" tab="environment" onTabChange={() => {}} onOpenComputer={() => {}} surfaceActive={active} />
        : <EnvironmentPanel surfaceActive={active} />}
    </div></main></BridgeProvider></TooltipProvider>;
  }
  createRoot(document.getElementById("root")!).render(<React.StrictMode><Harness /></React.StrictMode>);
}
void main();
