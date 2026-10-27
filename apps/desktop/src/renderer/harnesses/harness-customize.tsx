// Development-only fixture transport. No native config, account, or filesystem
// is read or written. The page, scope picker, editors, and cache are production.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { CustomizePage } from "../features/agent-extensions/customize-page";
import {
  AuthContext,
  type AuthContextValue,
} from "../features/auth/auth-context";
import { BridgeProvider } from "../platform/bridge/use-bridge";
import { RuntimeClient } from "../platform/bridge/ws-client";
import type { BridgeMessage } from "../platform/bridge/messages";
import type { ExtensionEntry } from "@zeros/protocol/agent-extensions";
import { TooltipProvider } from "../shared/ui/primitives/tooltip";
import { getSetting, setSetting } from "../platform/settings";
import { upsertProject } from "../state/projects-store";
import { Toaster } from "../shared/ui/primitives/elements/toast";

declare global {
  interface Window {
    mcpFormFixture: { failSave: boolean; failProbe: boolean; requiresAuth?: boolean; authorizations: string[]; holdProbe?: boolean; releaseProbe?: () => void; toolNames: string[]; probeCount: number; saveCount: number; setSurfaceActive?: (active: boolean) => void };
  }
}
window.mcpFormFixture = { failSave: false, failProbe: false, authorizations: [], toolNames: ["read_file", "search", "delete_file"], probeCount: 0, saveCount: 0 };
const connectedServers = new Set<string>();

if (!getSetting("customize:selection", null))
  setSetting("customize:selection", { category: "skills", provider: "zeros" });
upsertProject({ repoRoot: "/fixture/repo-a", name: "Repo A" });
upsertProject({ repoRoot: "/fixture/repo-b", name: "Repo B" });
const libraries = new Map<string, ExtensionEntry[]>();
const gatewayServers = [
  { name: "gateway-error", transport: "sse", url: "https://reports.example/events", auth: "oauth" },
  ...(new URLSearchParams(location.search).get("gatewayServers") === "multiple"
    ? [{ name: "gateway-second", transport: "http", url: "https://second.example/mcp", auth: "oauth" }]
    : []),
];
const settings = new Map<string, Record<string, unknown>>([
  ["user", { mcp: { servers: gatewayServers } }],
]);
const gatewayState = new URLSearchParams(location.search).get("gatewayState") === "needs-auth"
  ? "needs-auth" : "error";
const inventoryProviders: string[] = [];
Object.defineProperty(RuntimeClient.prototype, "status", {
  get: () => "connected",
});
RuntimeClient.prototype.connect = () => Promise.resolve();
RuntimeClient.prototype.request = async function <
  T extends BridgeMessage = BridgeMessage,
>(message: Partial<BridgeMessage> & { type: string }): Promise<T> {
  const request = message as {
    op?: string;
    params?: Record<string, unknown>;
    requestId?: string;
  };
  const params = request.params ?? {};
  const scope = String(params.repoRoot ?? "user");
  let result: unknown = {};
  if (request.op === "settings.resolve")
    result = { effective: {}, sources: {}, warnings: [] };
  if (request.op === "settings.read")
    result = {
      layer: params.layer,
      doc: settings.get(scope) ?? {},
      text: "",
      exists: settings.has(scope),
      path: `${scope}/.zeros/settings.local.toml`,
    };
  if (request.op === "settings.write") {
    const doc = { ...settings.get(scope), ...(params.patch as Record<string, unknown>) };
    settings.set(scope, doc);
    result = { layer: params.layer, path: `${scope}/.zeros/settings.local.toml`, doc, warnings: [] };
    document.getElementById("last-write")!.textContent = JSON.stringify(params);
  }
  if (request.op === "mcp.saveServer" || request.op === "mcp.deleteServer") {
    if (window.mcpFormFixture.failSave) throw new Error("MCP secrets could not be saved securely. Try again.");
    const current = settings.get(scope) ?? {};
    const servers = ((current.mcp as { servers?: Record<string, unknown>[] } | undefined)?.servers ?? []);
    const previous = params.previous as Record<string, unknown> | null;
    const index = previous ? servers.findIndex(row => previous.credential_id ? row.credential_id === previous.credential_id : row.name === previous.name) : -1;
    const server = params.server as Record<string, unknown>;
    const next = request.op === "mcp.deleteServer" ? servers.filter((_, offset) => offset !== index)
      : index < 0 ? [...servers, server] : servers.map((row, offset) => offset === index ? server : row);
    const doc = { ...current, mcp: { servers: next } };
    settings.set(scope, doc);
    result = { layer: params.layer, path: `${scope}/.zeros/settings.local.toml`, doc, warnings: [] };
    window.mcpFormFixture.saveCount++;
    // This output models ordinary configuration, never the private secret pipe.
    document.getElementById("last-write")!.textContent = JSON.stringify({ layer: params.layer, repoRoot: params.repoRoot, server });
  }
  if (request.op === "mcp.probe") {
    window.mcpFormFixture.probeCount++;
    if (window.mcpFormFixture.failProbe) throw new Error("Fixture connection unavailable");
    const server = params.server as Record<string, unknown>;
    const needsAuth = (server.auth === "oauth" || window.mcpFormFixture.requiresAuth) && !connectedServers.has(String(server.name));
    result = { status: needsAuth ? "needs-auth" : "connected", toolCount: needsAuth ? 0 : window.mcpFormFixture.toolNames.length,
      ...(!needsAuth ? { tools: [...window.mcpFormFixture.toolNames] } : {}),
      stages: [{ stage: "validation", status: "passed" }, { stage: "transport", status: "passed" },
        { stage: "initialize", status: needsAuth ? "needs-auth" : "passed" }, { stage: "tools", status: needsAuth ? "needs-auth" : "passed" }] };
    if (window.mcpFormFixture.holdProbe) await new Promise<void>(resolve => { window.mcpFormFixture.releaseProbe = resolve; });
  }
  if (request.op === "mcp.gateway.authorize") {
    window.mcpFormFixture.authorizations.push(String(params.server));
    connectedServers.add(String(params.server));
    result = { status: { name: params.server, state: "connected", toolCount: 3 } };
  }
  if (request.op === "mcp.resolveComposed") result = { servers: [], warnings: [] };
  if (request.op === "mcp.gateway.status") result = { running: true, error: null, servers: [...settings.values()].flatMap(doc => ((doc.mcp as { servers?: { name: string; url?: string; auth?: string }[] } | undefined)?.servers ?? []))
    .filter(server => server.auth === "oauth" || connectedServers.has(server.name)).map(({ name, url }) => ({ name, url, state: connectedServers.has(name) ? "connected" : gatewayState, toolCount: connectedServers.has(name) ? 3 : 0, detail: "Connection unavailable (503)" })) };
  if (request.op === "extensions.list") {
    inventoryProviders.push(String(params.provider));
    document.getElementById("inventory-providers")!.textContent =
      JSON.stringify(inventoryProviders);
    result = {
      entries:
        params.provider === "zeros"
          ? (libraries.get(scope) ?? [])
          : params.provider === "codex" && params.category === "apps"
            ? [
                {
                  id: "cloud",
                  name: "Cloud notes",
                  description: "Account connector",
                  sourcePath: "Codex account",
                  status: "available",
                },
                {
                  id: "native-only",
                  name: "Native surface",
                  description: "Native feature",
                  sourcePath: "Codex account",
                  status: "unavailable",
                  statusDetail:
                    "No tools available in Zeros. Some features require the native app.",
                },
              ]
            : [
                {
                  id: "native",
                  name: `${String(params.provider)} fixture`,
                  description: "Native configuration",
                  sourcePath: `${scope}/.${String(params.provider)}/config`,
                  status: "configured",
                },
              ],
      warnings: [],
    };
  }
  if (request.op === "skills.saveZeros") {
    const entry: ExtensionEntry = {
      id: String(params.name),
      name: String(params.name),
      description: String(params.description),
      body: String(params.body),
      revision: "saved",
      sourcePath: `${scope}/.zeros/skills/${String(params.name)}/SKILL.md`,
      status: "available",
    };
    libraries.set(scope, [
      ...(libraries.get(scope) ?? []).filter((skill) => skill.id !== entry.id),
      entry,
    ]);
    result = entry;
    document.getElementById("last-write")!.textContent = JSON.stringify(params);
  }
  if (request.op === "skills.removeZeros") {
    libraries.set(
      scope,
      (libraries.get(scope) ?? []).filter((entry) => entry.id !== params.name),
    );
    result = { ok: true };
  }
  return {
    type: "WORKSPACE_RESPONSE",
    requestId: request.requestId ?? "fixture",
    result,
  } as T;
};
const auth: AuthContextValue = {
  status: "unauthenticated",
  session: null,
  userId: null,
  email: null,
  startBrowserSignIn: async () => ({ ok: false }),
  oauthError: null,
  clearOAuthError: () => {},
  cancelPendingOAuth: () => {},
  signOut: async () => {},
  signOutEverywhere: async () => {},
};
function Harness() {
  const [surfaceActive, setSurfaceActive] = useState(true);
  window.mcpFormFixture.setSurfaceActive = setSurfaceActive;
  return (
  <AuthContext.Provider value={auth}>
    <TooltipProvider>
      <BridgeProvider>
        <main className="h-screen">
          <CustomizePage surfaceActive={surfaceActive} />
          <output id="last-write" hidden />
          <output id="inventory-providers" hidden />
          <Toaster />
        </main>
      </BridgeProvider>
    </TooltipProvider>
  </AuthContext.Provider>
  );
}
createRoot(document.getElementById("root")!).render(<Harness />);
