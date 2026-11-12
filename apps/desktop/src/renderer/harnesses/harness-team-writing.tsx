// Team sharing phase 2 (slice C) with production components and synthetic
// data: a member of an activated workspace writes as themself. The details
// card offers Restart and Stop, a refused send asks for the member's own
// agent account, a running turn names who it acts as, and the composer's
// personal-secret notice shows. The smoke intercepts every control-plane route.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";

const me = "11111111-1111-4111-8111-111111111111", organizationId = "22222222-2222-4222-8222-222222222222";
const alex = "44444444-4444-4444-8444-444444444444", workspaceId = "33333333-3333-4333-8333-333333333333";
const params = new URLSearchParams(location.search);
const calls: string[] = [];
(window as unknown as { __teamWritingFixture: { calls(): string[] } }).__teamWritingFixture = { calls: () => [...calls] };
window.__ZEROS_NATIVE__ = {
  on: () => () => {},
  async invoke<T>(command: string): Promise<T> {
    if (command === "auth_get_access_token") return { access_token: "synthetic-team-writing-session" } as T;
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
  const { restoreCloudWorkspaceCatalog } = await import("../state/cloud-workspace-catalog");
  const { CloudWorkspaceDetailsCard } = await import("../shell/conversation/cloud-workspace-details");
  const { TurnFailureCard } = await import("../features/agent/turn-failure-card");
  const { turnFailureForCard } = await import("../features/agent/turn-failure");
  const { ActingAs } = await import("../features/agent/acting-as");
  const { TeamWritingNotice } = await import("../features/agent/team-writing-notice");
  const { BLANK, useSessionsStore } = await import("../features/agent/sessions-store");

  const membership = [{ id: organizationId, slug: "fixture", name: "Organization A", logo: null, role: "member" as const, isPersonal: false, defaultTeamId: null,
    workspaceCapabilities: { local: true, cloud: true }, teamCapabilities: { multiple: false as const, canCreate: false as const } }];
  acceptOrganizationSnapshot({ user: { id: me, email: "fixture@example.test", displayName: "Fixture", staffRole: null }, organizations: membership, teams: membership });
  recordOrganizationSharing(organizationId, true);
  const doc = cloudV2Document(CloudV2WorkspaceSchema.parse({
    id: workspaceId, organizationId, creatorUserId: alex, name: "w-7", repository: "example/repo", branch: "zeros/w-7", baseBranch: "main",
    state: "running", errorCode: null, archivedAt: null, createdAt: new Date(Date.now() - 86_400_000).toISOString(), updatedAt: new Date().toISOString(), version: 2,
    capabilities: { design: false, browser: false, simulators: false, terminal: true, files: true, git: true, agents: ["claude"] },
    teamSharing: 1, createdByUserId: alex, viewerRole: "member", readOnly: false, canManage: false, following: true, pinned: false, followerIds: [me], followerCount: 1,
    teamWriting: 1, canExecute: true,
  }));
  restoreCloudWorkspaceCatalog([doc]);
  const folder = `cloud://${organizationId}/${workspaceId}`;
  useSessionsStore.getState().setSession("chat-a", { ...BLANK, cwd: folder, agentId: "claude", status: "streaming", actingUserId: params.get("actor") === "me" ? me : alex });
  const refusal = turnFailureForCard({ events: [], turnId: "unsent", status: "failed", recoveryFailure: { kind: "auth-required",
    message: "Connect your Claude account to send messages in this workspace.", cloud: { source: "provider", provider: "claude", reason: "auth-required" }, ownAccount: true } })!;

  function Harness() {
    return <main className="bg-bg1 flex min-h-screen gap-8 p-8">
      <section aria-label="Details" className="bg-bg3 w-[320px] shrink-0 rounded-lg p-4">
        <CloudWorkspaceDetailsCard workspace={doc} title="Fix login" statusLabel="Running" resources={null} changing={false} onChange={operation => { calls.push(operation); }} />
      </section>
      <section aria-label="Conversation" className="flex w-[640px] flex-col gap-4">
        <div aria-label="Running turn"><ActingAs chatId="chat-a" active /></div>
        <TurnFailureCard failure={refusal} onReconnect={provider => { calls.push(`connect:${provider}`); }} onRetry={() => { calls.push("retry"); }} />
        <div aria-label="Composer footer"><TeamWritingNotice folder={folder} /></div>
      </section>
    </main>;
  }
  document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark";
  createRoot(document.getElementById("root")!).render(<React.StrictMode><TooltipProvider><Harness /></TooltipProvider></React.StrictMode>);
}
void main();
