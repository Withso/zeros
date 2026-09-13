// Development-only fixture transport. No native config, account, or filesystem
// is read or written. The page, scope picker, editors, and cache are production.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import React from "react";
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

if (!getSetting("customize:selection", null))
  setSetting("customize:selection", { category: "skills", provider: "zeros" });
upsertProject({ repoRoot: "/fixture/repo-a", name: "Repo A" });
upsertProject({ repoRoot: "/fixture/repo-b", name: "Repo B" });
const libraries = new Map<string, ExtensionEntry[]>();
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
      doc: {},
      text: "",
      exists: false,
      path: `${scope}/.zeros/settings.local.toml`,
    };
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
createRoot(document.getElementById("root")!).render(
  <AuthContext.Provider value={auth}>
    <TooltipProvider>
      <BridgeProvider>
        <main className="h-screen">
          <CustomizePage />
          <output id="last-write" hidden />
          <output id="inventory-providers" hidden />
        </main>
      </BridgeProvider>
    </TooltipProvider>
  </AuthContext.Provider>,
);
