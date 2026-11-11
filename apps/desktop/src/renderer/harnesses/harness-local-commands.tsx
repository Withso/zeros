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
  const now = Date.now();
  function Setting() {
    const [checked, setChecked] = React.useState(false);
    return <LocalCommandsSetting checked={checked} onCheckedChange={value => { calls.push(`always:${value}`); setChecked(value); }} />;
  }
  function Harness() {
    const view = params.get("view") ?? "card";
    if (view === "transcript") {
      // RunLocalCommand as each provider records it, waiting and ended; and Claude's ToolSearch row that loads it (hidden).
      const args = { command: "xcrun simctl list devices | grep Booted", description: "List booted simulators", mac: "Studio" };
      const tool = (id: string, title: string, rawInput: unknown, status: string, text?: string, toolKind = "mcp") => ({ kind: "tool", id, toolCallId: id, nativeToolCallId: id, title, toolKind,
        status, rawInput, createdAt: 1, updatedAt: 2, content: text ? [{ type: "content", content: { type: "text", text } }] : [] });
      const rows = [
        tool("search", "ToolSearch", { query: "select:mcp__zeros_workspace__RunLocalCommand" }, "completed", undefined, "tool_search"),
        tool("waiting", "mcp__zeros_workspace__RunLocalCommand", args, "in_progress"),
        tool("ran", "zeros_workspace:RunLocalCommand", { server: "zeros_workspace", tool: "RunLocalCommand", arguments: args }, "completed", "outcome: completed\nmac: Studio\nexit code: 0\n"),
        tool("denied", "MCP RunLocalCommand", { providerIdentifier: "zeros_workspace", toolName: "RunLocalCommand", args }, "failed", "outcome: denied\nmac: Studio\n"),
        tool("exit", "mcp__zeros_workspace__RunLocalCommand", args, "completed", "outcome: completed\nmac: Studio\nexit code: 3\n"),
      ];
      return <main className="bg-bg1 min-h-screen p-8"><div className="mx-auto max-w-2xl space-y-2">
        {rows.filter(row => toolPresentationReady(row as never)).map(row => <article key={row.id} data-local-command-row={row.id}>
          <EventRowRenderer message={row as never} ctx={{ editBaselines: new Map() } as never} /></article>)}
      </div></main>;
    }
    if (view === "setting") return <main className="bg-bg1 min-h-screen p-8"><div className="mx-auto max-w-2xl"><Setting /></div></main>;
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
