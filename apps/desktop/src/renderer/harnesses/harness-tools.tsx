import { providerAuthChanged } from "../platform/provider-auth-state";
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ComposerTools } from "../features/agent/composer-tools";
import { useComposerEditor } from "../features/agent/composer-editor";
import type { AvailableCommand } from "../platform/bridge/agent-events";
import { ContextGauge } from "../features/agent/context-gauge";
import { BridgeProvider } from "../platform/bridge/use-bridge";
import { RuntimeClient } from "../platform/bridge/ws-client";
import type { BridgeMessage } from "../platform/bridge/messages";
import { Button } from "../shared/ui";
import { TooltipProvider } from "../shared/ui/primitives/tooltip";

let signedIn = false;
let failRefresh = false;
let holdAuth = false;
let inventoryMode: "normal" | "empty" | "unsupported" = "normal";
const authReleases: (() => void)[] = [];
let openedCount = 0;
const requests: unknown[] = [];
Object.defineProperty(RuntimeClient.prototype, "status", {
  get: () => "connected",
});
RuntimeClient.prototype.connect = () => Promise.resolve();
RuntimeClient.prototype.request = async function <
  T extends BridgeMessage = BridgeMessage,
>(message: Partial<BridgeMessage> & { type: string }): Promise<T> {
  const request = message as { op?: string; params?: { sessionId: string } };
  requests.push(request);
  document.getElementById("requests")!.textContent = JSON.stringify(requests);
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (request.op === "tools.session.authenticate") {
    if (holdAuth)
      await new Promise<void>((resolve) => {
        authReleases.push(resolve);
        document.getElementById("pending-auth")!.textContent = String(
          authReleases.length,
        );
      });
    return {
      type: "WORKSPACE_RESPONSE",
      result: {
        authorizationUrl: "https://auth.example/authorize?state=fixture",
      },
    } as unknown as T;
  }
  if (failRefresh) throw new Error("Fixture offline");
  if (inventoryMode !== "normal")
    return {
      type: "WORKSPACE_RESPONSE",
      result: {
        state: inventoryMode === "empty" ? "ready" : "unsupported",
        entries: [],
        ...(inventoryMode === "empty" &&
        request.op === "tools.session.inventory"
          ? {
              groups: ["plugins", "apps", "mcp"].map((kind) => ({
                kind,
                state: "ready",
                entries: [],
              })),
            }
          : {}),
      },
    } as unknown as T;
  const result = {
    state: "ready",
    detail: "Fixture inventory description.",
    entries:
      request.params?.sessionId === "a"
        ? [
            { id: "codex_apps", name: "codex_apps", status: "connected" },
            {
              id: "notes",
              name: "Notes",
              status: signedIn ? "connected" : "needs-auth",
              canAuthenticate: !signedIn,
            },
            { id: "broken", name: "Broken", status: "error" },
          ]
        : [{ id: "calendar", name: "Calendar", status: "needs-auth" }],
  };
  const groups =
    request.params?.sessionId === "a"
      ? [
          {
            kind: "plugins",
            state: "ready",
            entries: [
              {
                id: "notes-plugin",
                name: "Notes plugin",
                status: "enabled",
                detail: "Includes the Notes app.",
              },
              {
                id: "disabled-plugin",
                name: "Disabled plugin",
                status: "disabled",
              },
            ],
          },
          {
            kind: "apps",
            state: "ready",
            entries: [
              {
                id: "notes-app",
                name: "Notes app",
                status: "available",
                detail: "From Notes plugin. Uses codex_apps.",
              },
              { id: "disabled-app", name: "Disabled app", status: "disabled" },
            ],
          },
          { kind: "mcp", state: "ready", entries: result.entries },
        ]
      : [
          {
            kind: "plugins",
            state: "unsupported",
            entries: [],
            detail:
              "Claude has not reported this session’s loaded plugins yet.",
          },
          { kind: "apps", state: "ready", entries: result.entries },
          { kind: "mcp", state: "ready", entries: result.entries },
        ];
  return {
    type: "WORKSPACE_RESPONSE",
    result: {
      ...result,
      ...(request.op === "tools.session.inventory" ? { groups } : {}),
    },
  } as unknown as T;
};
window.open = (url) => {
  document.getElementById("opened-url")!.textContent = String(url);
  document.getElementById("opened-count")!.textContent = String(++openedCount);
  return null;
};

function ClaudeSkillsComposer() {
  const [commands, setCommands] = useState<AvailableCommand[]>([]);
  const [opens, setOpens] = useState(0);
  const [submissions, setSubmissions] = useState(0);
  const composer = useComposerEditor({
    agentId: "claude",
    agentName: "Claude",
    agentSupportsImage: false,
    modelId: null,
    cwd: null,
    originUrl: null,
    availableCommands: commands,
    placeholder: "Ask Claude…",
    onSubmit: () => setSubmissions((value) => value + 1),
    onSlashOpen: () => {
      setOpens((value) => value + 1);
      // Simulate the native control read landing while the picker stays open.
      window.setTimeout(
        () =>
          setCommands([
            { name: "simplify", description: "Simplify code", kind: "skill" },
          ]),
        100,
      );
    },
  });
  return (
    <div className="relative" data-claude-skills-composer="">
      {composer.suggestionPopup}
      {composer.editorContent}
      <output hidden id="command-opens">
        {opens}
      </output>
      <output hidden id="command-submissions">
        {submissions}
      </output>
    </div>
  );
}

function Harness() {
  const [owner, setOwner] = useState("a");
  const [hidden, setHidden] = useState(false);
  const [ready, setReady] = useState(true);
  const [preparing, setPreparing] = useState(false);
  const [preparations, setPreparations] = useState(0);
  const [skillsComposer, setSkillsComposer] = useState(false);
  return (
    <main className="bg-bg1 text-fg1 flex h-screen flex-col p-6">
      <div className="flex flex-wrap gap-2">
        <Button
          onClick={() => {
            holdAuth = true;
          }}
        >
          Delay authentication
        </Button>
        <Button onClick={providerAuthChanged}>Switch account</Button>
        <Button
          onClick={() => {
            for (const release of authReleases.splice(0)) release();
          }}
        >
          Release authentication
        </Button>
        <Button onClick={() => setOwner("a")}>Chat A</Button>
        <Button onClick={() => setOwner("b")}>Chat B</Button>
        <Button
          onClick={() => {
            inventoryMode = "empty";
          }}
        >
          Empty inventory
        </Button>
        <Button
          onClick={() => {
            inventoryMode = "unsupported";
          }}
        >
          Unavailable inventory
        </Button>
        <Button
          onClick={() => {
            inventoryMode = "normal";
          }}
        >
          Restore inventory
        </Button>
        <Button onClick={() => setReady(false)}>Cold chat</Button>
        <Button onClick={() => setSkillsComposer(true)}>Claude skills</Button>
        <Button onClick={() => setHidden((value) => !value)}>
          Toggle retained chat
        </Button>
        <Button
          onClick={() => {
            signedIn = true;
          }}
        >
          Complete sign-in
        </Button>
        <Button
          onClick={() => {
            failRefresh = true;
          }}
        >
          Fail refresh
        </Button>
      </div>
      <div className="bg-bg2 mt-auto rounded-lg p-3" hidden={hidden}>
        {skillsComposer && <ClaudeSkillsComposer />}
        <p className="text-fg2 p-2 text-sm">Ask to make changes…</p>
        <div
          className="flex items-center justify-end gap-1.5"
          data-composer-toolbar-actions=""
        >
          <ComposerTools
            ownerId={owner}
            agentId={owner === "a" ? "codex" : "claude"}
            sessionId={ready ? owner : null}
            workspaceId={owner}
            concealed={hidden}
            preparing={preparing}
            onPrepare={() => {
              if (ready || preparing) return;
              setPreparing(true);
              setPreparations((value) => value + 1);
              window.setTimeout(() => {
                setReady(true);
                setPreparing(false);
              }, 100);
            }}
          />
          <ContextGauge usage={null} />
        </div>
      </div>
      <output hidden id="pending-auth" />
      <output hidden id="opened-count" />
      <output hidden id="requests" />
      <output hidden id="opened-url" />
      <output hidden id="preparations">
        {preparations}
      </output>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <BridgeProvider>
      <Harness />
    </BridgeProvider>
  </TooltipProvider>,
);
