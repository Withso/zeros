// Real settings UI and request boundary; synthetic identities and transport only.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ProvidersPanel } from "../features/settings/providers-panel";
import { acceptOrganizationSnapshot, clearTeamStore } from "../features/team/team-store";
import { setActiveOrganizationSelection } from "../features/team/active-team";
import { clearCloudProviderConnections } from "../features/settings/cloud-provider-connection";
import { clearCloudAgentRegistry } from "../features/agent/workspace-agent-registry";
import { controlPlane } from "../features/team/control-plane";
import { setActiveBridge } from "../platform/bridge/active-bridge";
import type { RuntimeClient } from "../platform/bridge/ws-client";
import { acceptCloudWorkspaceDocument } from "../state/cloud-workspace-catalog";
import { Button, TooltipProvider } from "../shared/ui/primitives";
import { setSetting } from "../platform/settings";

const organizationId = "11111111-1111-4111-8111-111111111111";
const userA = "44444444-4444-4444-8444-444444444444";
const userB = "55555555-5555-4555-8555-555555555555";
let user = userA;
function installAccount(next: string) {
  user = next;
  clearTeamStore({ resetSelection: true });
  clearCloudProviderConnections();
  clearCloudAgentRegistry();
  const organization = { id: organizationId, slug: "fixture", name: "Example organization", logo: null,
    isPersonal: false, role: "owner" as const, defaultTeamId: organizationId,
    workspaceCapabilities: { local: false, cloud: true }, teamCapabilities: { multiple: false as const, canCreate: false as const } };
  acceptOrganizationSnapshot({ user: { id: user, email: "fixture@example.test", displayName: "Fixture", staffRole: null },
    teams: [organization], organizations: [organization] });
  setActiveOrganizationSelection(organizationId, false);
  setSetting("organization:membership-history-v1", { version: 1, accounts: [{
    userId: user, personalId: null, organizationIds: [organizationId], retiredOrganizationIds: [], updatedAt: Date.now(),
  }] });
}
controlPlane.me = async () => { throw new Error("Harness membership refresh unavailable"); };
window.__ZEROS_NATIVE__ = {
  async invoke<T>(command: string): Promise<T> {
    if (command === "auth_get_access_token") return { access_token: `fixture-${user}` } as T;
    if (command === "auth_get_session_user") return { sub: user, accountId: user, email: "fixture@example.test", name: "Fixture", provider: "workos" } as T;
    throw new Error(`Cloud settings attempted native command: ${command}`);
  },
  on: () => () => {},
};
setActiveBridge({
  async request(message: { type: string; cwd?: string }) {
    if (message.type !== "AGENT_LIST_AGENTS" || !message.cwd?.startsWith("cloud://"))
      throw new Error("Cloud settings attempted a local engine operation");
    return { type: "AGENT_AGENTS_LIST", agents: [
      { id: "claude", name: "Claude", installed: true, authenticated: false },
      { id: "codex", name: "Codex", installed: true, authenticated: false },
    ] };
  },
} as unknown as RuntimeClient);
for (const [id, name] of [["22222222-2222-4222-8222-222222222222", "Workspace A"], ["33333333-3333-4333-8333-333333333333", "Workspace B"]]) {
  acceptCloudWorkspaceDocument({
    id, organizationId, teamId: organizationId, createdBy: userA, name, placement: "cloud", status: "ready", version: 1,
    error: null, createdAt: "2026-09-26T00:00:00Z", updatedAt: "2026-09-26T00:00:00Z", deletedAt: null,
    capabilities: { canWrite: true, canManage: true, canStart: true, startUnavailableReason: null },
    repository: { forge: "github.com", owner: "example", name: "project", revision: "refs/heads/main" },
    generation: { number: 1, architecture: "x86_64", resources: { cpuMillicores: 2000, memoryMiB: 4096, storageMiB: 20480 }, observedState: "running", lastObservedAt: null },
  });
}
installAccount(userA);
function Harness() {
  const [active, setActive] = useState(true);
  return <TooltipProvider><main className="bg-bg1 text-fg1 min-h-screen p-8">
    <div className="mb-6 flex gap-2">
      <Button onClick={() => installAccount(userB)}>Account B</Button>
      <Button onClick={() => clearTeamStore()}>Reload membership</Button>
      <Button onClick={() => setActive(value => !value)}>Toggle settings activity</Button>
    </div>
    <ProvidersPanel surfaceActive={active} />
  </main></TooltipProvider>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
