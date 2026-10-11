// Offline canonical snapshots. Adapter regressions exercise native login ids
// and approval mapping; this harness uses the shipping renderer components.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { SessionToolsSnapshot } from "@zeros/protocol/agent-extensions";
import type { RequestPermissionRequest } from "../platform/bridge/agent-events";
import { ComposerToolGroups } from "../features/agent/composer-tool-groups";
import { PermissionCard } from "../features/agent/permission-card";
import { Surface } from "../shared/ui/layout/surface";

type OAuthState = "authenticate" | "opening" | "stale-completion" | "connected" | "failed";
const states: OAuthState[] = ["authenticate", "opening", "stale-completion", "connected", "failed"];
const labels: Record<OAuthState, string> = {
  authenticate: "Needs sign-in", opening: "Opening", "stale-completion": "Retry · stale result ignored",
  connected: "Connected", failed: "Failed",
};
const setters = new Map<string, (state: OAuthState) => void>();
declare global {
  interface Window {
    setCodexMcpFixture: (id: OAuthState, state: OAuthState) => void;
    codexPermissionResponses: string[];
  }
}
window.setCodexMcpFixture = (id, state) => setters.get(id)?.(state);
window.codexPermissionResponses = [];
const query = new URLSearchParams(location.search);
const placement = query.get("placement") === "cloud" ? "cloud" : "local";
const cwd = placement === "cloud" ? "/srv/zeros/workspace" : "/Users/fixture/workspace";
document.documentElement.setAttribute("data-theme", query.get("theme") === "light" ? "light" : "dark");

function OAuthFixture({ id }: { id: OAuthState }) {
  const [state, setState] = useState(id);
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    setters.set(id, setState);
    // Open the real disclosure once so every mock state is visible on load.
    root.current?.querySelector<HTMLButtonElement>("[data-tool-group=mcp] > button")?.click();
    return () => { setters.delete(id); };
  }, [id]);
  const linear: SessionToolsSnapshot["entries"][number] = {
    id: "linear", name: "linear",
    status: state === "authenticate" ? "needs-auth" : state === "connected" ? "connected" : state === "failed" ? "error" : "connecting",
    canAuthenticate: state !== "connected",
  };
  const entries: SessionToolsSnapshot["entries"] = [
    { id: "github", name: "github", status: "connected" }, linear,
    { id: "sentry", name: "sentry", status: "connected" },
  ];
  return (
    <section id={`codex-mcp-${id}`} data-codex-oauth-state={state} className="flex flex-col gap-2">
      <div className="text-fg3 text-xs">{labels[id]}</div>
      <Surface ref={root} kind="floating" className="border-border2 w-80 max-w-full rounded-lg border p-2">
        <ComposerToolGroups snapshot={{ state: "ready", entries, groups: [{ kind: "mcp", state: "ready", entries }] }}
          authBusy={null} onAuthenticate={() => setState("opening")} />
      </Surface>
    </section>
  );
}

const options: RequestPermissionRequest["options"] = [
  { optionId: "accept", name: "Yes", kind: "allow_once" },
  { optionId: "acceptForSession", name: "Allow for this chat", kind: "allow_always" },
  { optionId: "decline", name: "No", kind: "reject_once" },
];
const permission = (write: boolean): RequestPermissionRequest => ({
  sessionId: "fixture", nativeRequestId: write ? "write-access" : "ordinary-command", options,
  // Both fixtures retain the existing provider-authored option presentation.
  useOptionNames: true,
  ...(write ? { title: "Do you want to allow write access outside the workspace?", contextItems: ["Write · ../shared/build"] } : {}),
  toolCall: { toolCallId: write ? "write-access" : "ordinary-command", title: "Bash", kind: "execute", status: "pending",
    rawInput: write ? { command: "pnpm build --out ../shared/build", cwd, approvalKind: "command",
      additionalPermissions: { network: null, fileSystem: { read: null, write: [cwd + "/../shared/build"] } }, codexWriteAccessPath: "../shared/build" }
      : { command: "pnpm test --filter engine", description: "Bash", cwd },
  },
});

function Harness() {
  return (
    <Surface role="main" kind="canvas" className="text-fg1 flex min-h-screen flex-col gap-6 p-6" data-placement={placement}>
      <div className="grid gap-4 lg:grid-cols-3">{states.map(id => <OAuthFixture key={id} id={id} />)}</div>
      <div className="grid gap-4 lg:grid-cols-2">
        {[true, false].map(write => {
          const id = write ? "codex-write-access" : "codex-ordinary-approval";
          return (
            <section key={id} id={id} data-pane-root="" data-pane-focused="true" className="flex flex-col gap-2">
              <div className="text-fg3 text-xs">{write ? "Write access" : "Other approvals · unchanged"}</div>
              <PermissionCard request={permission(write)} cwd={cwd} onRespond={response => {
                if (response.outcome.outcome === "selected") window.codexPermissionResponses.push(`${id}:${response.outcome.optionId}`);
              }} />
            </section>
          );
        })}
      </div>
    </Surface>
  );
}
createRoot(document.getElementById("root")!).render(<Harness />);
