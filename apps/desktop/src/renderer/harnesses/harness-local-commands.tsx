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
  const now = Date.now();
  function Setting() {
    const [checked, setChecked] = React.useState(false);
    return <LocalCommandsSetting checked={checked} onCheckedChange={value => { calls.push(`always:${value}`); setChecked(value); }} />;
  }
  function Harness() {
    const view = params.get("view") ?? "card";
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
