// Local commands UI against local fixtures only: the approval card, the
// Connected Macs rows in the real popover and the Advanced setting. No device
// channel or control plane is involved; choices are recorded for the smoke.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";

const params = new URLSearchParams(location.search);
const calls: string[] = [];
(window as unknown as { __localCommands: { calls(): string[] } }).__localCommands = { calls: () => [...calls] };

async function main() {
  const React = await import("react"), { createRoot } = await import("react-dom/client");
  const { TooltipProvider } = await import("../shared/ui/primitives");
  const { Popover, PopoverAnchor, PopoverContent } = await import("../shared/ui/primitives/popover");
  const { LocalCommandApprovalCard } = await import("../features/agent/local-command-card");
  const { ConnectedMacs } = await import("../shell/conversation/connected-macs");
  const { LocalCommandsSetting } = await import("../features/settings/local-commands-setting");
  const { EventRowRenderer } = await import("../features/agent/renderers/event-row-renderer");
  const { toolPresentationReady } = await import("../features/agent/renderers/tool-readiness");
  const { LocalCommandChatApprovals } = await import("../features/agent/local-command-approvals");
  const { acceptLocalCommandApprovalsForTests } = await import("../platform/local-commands");
  const { cloudScopedId } = await import("../platform/bridge/cloud-workspace-key");
  const { restoreCloudWorkspaceCatalog } = await import("../state/cloud-workspace-catalog");
  const { cloudV2Document, CloudV2WorkspaceSchema } = await import("../platform/cloud-v2");
  const now = Date.now();
  function Setting() {
    const [checked, setChecked] = React.useState(false);
    return <LocalCommandsSetting checked={checked} onCheckedChange={value => { calls.push(`always:${value}`); setChecked(value); }} />;
  }
  function Harness() {
    const view = params.get("view") ?? "card";
    if (view === "transcript") {
      // RunLocalCommand as each provider records it: waiting on a held approval (chat A, whose approval card is in its
      // dock), running with Always allow (chat B, nothing held), and ended; plus ToolSearch rows that stay hidden
      // (a finished one loading it, and a pending one whose query has not arrived).
      const args = { command: "xcrun simctl list devices | grep Booted", description: "List booted simulators", mac: "Studio" };
      const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
      const chatA = cloudScopedId(target, "chat-a"), chatB = cloudScopedId(target, "chat-b");
      const tool = (id: string, title: string, rawInput: unknown, status: string, text?: string, toolKind = "mcp") => ({ kind: "tool", id, toolCallId: id, nativeToolCallId: id, title, toolKind,
        status, rawInput, createdAt: 1, updatedAt: 2, content: text ? [{ type: "content", content: { type: "text", text } }] : [] });
      const rows = [
        tool("search", "ToolSearch", { query: "select:mcp__zeros_workspace__RunLocalCommand" }, "completed", undefined, "tool_search"),
        tool("search-pending", "ToolSearch", {}, "in_progress", undefined, "tool_search"),
        tool("waiting", "mcp__zeros_workspace__RunLocalCommand", { ...args, reason: "The simulator only runs on the Mac." }, "in_progress"),
        tool("running", "mcp__zeros_workspace__RunLocalCommand", args, "in_progress"),
        tool("ran", "zeros_workspace:RunLocalCommand", { server: "zeros_workspace", tool: "RunLocalCommand", arguments: args }, "completed", "outcome: completed\nmac: Studio\nexit code: 0\n"),
        tool("denied", "MCP RunLocalCommand", { providerIdentifier: "zeros_workspace", toolName: "RunLocalCommand", args }, "failed", "outcome: denied\nmac: Studio\n"),
        tool("exit", "mcp__zeros_workspace__RunLocalCommand", args, "completed", "outcome: completed\nmac: Studio\nexit code: 3\n"),
      ];
      const held = params.get("approval") !== "none";
      restoreCloudWorkspaceCatalog([cloudV2Document(CloudV2WorkspaceSchema.parse({ id: target.workspaceId, organizationId: target.organizationId,
        creatorUserId: "33333333-3333-4333-8333-333333333333", name: "w-7", repository: "example/repo", branch: "zeros/w-7", baseBranch: "main", state: "running",
        errorCode: null, archivedAt: null, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", version: 2,
        capabilities: { design: false, browser: false, simulators: false, terminal: true, files: true, git: true, agents: ["codex"] } }))]);
      acceptLocalCommandApprovalsForTests(held ? [{ requestId: "req-a", workspaceId: target.workspaceId, workspaceName: "w-7", workspaceTitle: "Fix login",
        chatId: "chat-a", chatTitle: "Simulator check", macName: "Studio", command: args.command, description: args.description,
        timeoutMs: 60_000, approvalDeadline: new Date(now + 60_000).toISOString() }] : []);
      return <main className="bg-bg1 min-h-screen p-8"><div className="mx-auto max-w-2xl space-y-2">
        {rows.filter(row => toolPresentationReady(row as never)).map(row => <article key={row.id} data-local-command-row={row.id}>
          <EventRowRenderer message={row as never} ctx={{ editBaselines: new Map(), chatId: row.id === "running" ? chatB : chatA } as never} /></article>)}
        <section aria-label="Chat A dock" data-chat-dock="a"><LocalCommandChatApprovals chatId={chatA} active /></section>
      </div></main>;
    }
    if (view === "setting") return <main className="bg-bg1 min-h-screen p-8"><div className="mx-auto max-w-2xl"><Setting /></div></main>;
    if (view === "sync") {
      // 12.z: a switch under each connected Mac. This Mac off (sync=off) or a status with its folder; Studio's switch
      // is its wanted state (old=1: a control plane without 12.z, so only This Mac's switch is live). Actions record calls.
      const state = params.get("sync") ?? "off";
      const status = state === "off" ? null : { workspaceId: "w", state: state as "syncing" | "in_sync" | "paused" | "error",
        ...(state === "syncing" ? { files: 12 } : {}), ...(state === "error" ? { reason: "too_many_bytes" } : {}), problems: 0,
        folder: "/Users/alex/zeros/cloud-sync/zeros/w-19" };
      const old = params.has("old");
      return <main className="bg-bg1 min-h-screen p-8">
        <Popover open>
          <PopoverAnchor asChild><span className="inline-block size-1" /></PopoverAnchor>
          <PopoverContent align="start" sideOffset={6} className="w-[320px]" aria-label="Cloud workspace details">
            <ConnectedMacs now={now} onConnect={() => {}} onDisconnect={() => {}} onSetWanted={(deviceId, wanted) => calls.push(`wanted:${deviceId}:${wanted}`)} macs={[
              { deviceId: "d1", name: "Alex's MacBook Pro", thisMac: true, state: "connected", reachable: true },
              { deviceId: "d2", name: "Studio", thisMac: false, state: "connected", reachable: true, syncing: true, ...(old ? {} : { syncWanted: true }) },
            ]} sync={{ status, busy: false, onEnable: () => calls.push("sync:enable"), onChoose: () => calls.push("sync:choose"), onStop: () => calls.push("sync:stop"),
              onOpenTerminal: () => calls.push("sync:terminal"), onReveal: () => calls.push("sync:reveal"), onCopyPath: () => calls.push("sync:copy") }} />
          </PopoverContent>
        </Popover>
      </main>;
    }
    if (view === "macs") return <main className="bg-bg1 min-h-screen p-8">
      <Popover open>
        <PopoverAnchor asChild><span className="inline-block size-1" /></PopoverAnchor>
        <PopoverContent align="start" sideOffset={6} className="w-[320px]" aria-label="Cloud workspace details">
          <ConnectedMacs now={now} onConnect={id => calls.push(`connect:${id}`)} onDisconnect={id => calls.push(`disconnect:${id}`)} macs={[
            { deviceId: "d1", name: "Alex's MacBook Pro", thisMac: true, state: "available", reachable: true },
            { deviceId: "d2", name: "Studio", thisMac: false, state: "connected", expiresAt: now + 4 * 3600_000 + 60_000, reachable: true },
            { deviceId: "d3", name: "Old Mini", thisMac: false, state: "active", reachable: false },
          ]} />
        </PopoverContent>
      </Popover>
    </main>;
    return <main className="bg-bg1 min-h-screen p-8"><div className="mx-auto max-w-[640px]">
      <LocalCommandApprovalCard onDecide={decision => calls.push(decision)} request={{ requestId: "fixture", macName: "Alex's MacBook Pro",
        workspaceName: "w-7 · Fix login", chatTitle: "Simulator check", command: "xcrun simctl list devices | grep Booted", cwd: "~/src/app",
        description: "List booted simulators", reason: "Verify the iOS build", timeoutMs: params.has("extended") ? 1_800_000 : 60_000,
        ...(params.has("extended") ? { extendedTimeoutReason: "Full archive build" } : {}), ...(params.has("explicit") ? { explicitFrom: "Alex's Mac mini" } : {}) }} />
    </div></main>;
  }
  document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark";
  createRoot(document.getElementById("root")!).render(<React.StrictMode><TooltipProvider><Harness /></TooltipProvider></React.StrictMode>);
}
void main();
