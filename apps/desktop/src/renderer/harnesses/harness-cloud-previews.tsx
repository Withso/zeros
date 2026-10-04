// Real Browser and staff gate. Native admission is synthetic; this harness
// verifies renderer lifecycle, while Electron/runtime suites own authority.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserTab } from "../shell/workbench/tabs/browser-tab";
import { createBrowserTab } from "../shell/workbench/tab-model";
import {
  ActionsCtx,
  type SessionsActions,
} from "../features/agent/sessions-context";
import { TooltipProvider } from "../shared/ui/primitives";
import { Button } from "../shared/ui";
import {
  acceptOrganizationSnapshot,
  clearTeamStore,
} from "../features/team/team-store";
import { setInternalFeatureEnabled } from "../features/settings/internal-features";
import { cloudScopedId } from "../platform/bridge/cloud-workspace-key";

const organizationId = "11111111-1111-4111-8111-111111111111";
const firstWorkspace = "22222222-2222-4222-8222-222222222222";
const secondWorkspace = "33333333-3333-4333-8333-333333333333";
let currentWorkspace = firstWorkspace;
const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
const pending: Array<() => void> = [];
const fixture = {
  calls,
  hold: false,
  legacy: false,
  release: () => pending.shift()?.(),
};
Object.assign(window, { cloudPreviewFixture: fixture });
let next = 0;
window.__ZEROS_NATIVE__ = {
  async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    calls.push({ command, args });
    if (command === "cloud_workspace_access_context")
      return {
        authorityId: organizationId,
        deviceId: firstWorkspace,
        keyVersion: 1,
      } as T;
    if (command === "browser:open-cloud-preview") {
      const id = ++next;
      if (fixture.hold)
        await new Promise<void>((resolve) => pending.push(resolve));
      const origin = `https://${String(id).padStart(32, "0")}.preview.example.test`;
      return {
        accessId: `preview-${id}`,
        logicalUrl: "http://localhost:5173/",
        origin,
        admissionUrl: `${origin}/`,
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      } as T;
    }
    if (command === "cloud_workspace_access_revoke") return true as T;
    if (command === "browser:control-iframe") {
      const frame = document.querySelector<HTMLIFrameElement>(
        `iframe[name="${args!.frameName}"]`,
      );
      frame?.contentWindow?.location.replace(String(args!.url));
      return { ok: Boolean(frame) } as T;
    }
    if (command === "browser:authorize-preview-origin")
      return { ok: true } as T;
    return { ok: false } as T;
  },
  on: () => () => {},
};
acceptOrganizationSnapshot({
  user: {
    id: organizationId,
    email: "fixture@example.test",
    displayName: "Fixture",
    staffRole: "developer",
  },
  organizations: [],
  teams: [],
});
setInternalFeatureEnabled("cloudComputerV2", true);
const tab = createBrowserTab({
  url: "http://localhost:5173/assets?version=2",
  title: "Native preview",
  previewSource: {
    chatId: "chat-native",
    port: 5173,
    ...(new URLSearchParams(location.search).has("legacy-source")
      ? {}
      : {
          executionId: "execution-native",
          portId: "A".repeat(32),
        }),
  },
});
function Harness() {
  const [active, setActive] = useState(false);
  const [workspace, setWorkspace] = useState(firstWorkspace);
  currentWorkspace = workspace;
  const ownedTab = {
    ...tab,
    previewSource: {
      ...tab.previewSource!,
      ...(tab.previewSource?.executionId
        ? {
            executionId: new URLSearchParams(location.search).has(
              "invalid-source",
            )
              ? `cloud:${organizationId}:${workspace}:%ZZ`
              : cloudScopedId(
                  { organizationId, workspaceId: workspace },
                  "execution-native",
                ),
          }
        : {}),
    },
  };
  return (
    <main className="bg-bg0 text-fg1 flex h-screen flex-col p-4">
      <nav className="mb-4 flex gap-2">
        <Button onClick={() => setActive((value) => !value)}>
          Toggle active
        </Button>
        <Button
          onClick={() =>
            setWorkspace((value) =>
              value === firstWorkspace ? secondWorkspace : firstWorkspace,
            )
          }
        >
          Switch workspace
        </Button>
        <Button
          onClick={() => {
            clearTeamStore();
            acceptOrganizationSnapshot({
              user: {
                id: secondWorkspace,
                email: "second@example.test",
                displayName: "Second",
                staffRole: "developer",
              },
              organizations: [],
              teams: [],
            });
          }}
        >
          Switch account
        </Button>
        <Button
          onClick={() => setInternalFeatureEnabled("cloudComputerV2", false)}
        >
          Disable previews
        </Button>
      </nav>
      <BrowserTab
        tab={ownedTab}
        active={active}
        scope={`cloud://${organizationId}/${workspace}`}
      />
    </main>
  );
}
const sessions = {
  getSession: () => ({
    executionId: cloudScopedId(
      { organizationId, workspaceId: currentWorkspace },
      "execution-native",
    ),
    boundaryPorts: { ports: [{ id: "A".repeat(32), port: 5173 }] },
  }),
  openBoundaryPort: async () => {
    calls.push({ command: "engine:open-preview" });
    const url = "http://localhost:5173/";
    return fixture.legacy
      ? {
          url,
          admissionUrl:
            "https://legacy.preview.example.test/?__zsr_cap=fixture",
          expiresAt: Date.now() + 30 * 60_000,
        }
      : {
          url,
          admissionUrl: url,
          expiresAt: Date.now() + 60_000,
          nativeTarget: {
            executionId: "execution-native",
            portId: "A".repeat(32),
          },
        };
  },
} as unknown as SessionsActions;
createRoot(document.getElementById("root")!).render(
  <ActionsCtx.Provider value={sessions}>
    <TooltipProvider>
      <Harness />
    </TooltipProvider>
  </ActionsCtx.Provider>,
);
