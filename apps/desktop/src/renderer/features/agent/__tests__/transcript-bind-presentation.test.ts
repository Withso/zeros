import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BLANK, useSessionsStore } from "../sessions-store";
import { admissionRouteWithoutFlight, cancelGeneration, cancelledSince, executionActorForRecovery } from "../session-reload-lifecycle";
import { isCloudWorkspace } from "../../../platform/bridge/cloud-workspace-key";

const ast = ts.createSourceFile("sessions-provider.tsx", readFileSync(new URL("../sessions-provider.tsx", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const callbacks: Record<string, string> = {};
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && ["loadIntoChat", "ensureSession"].includes(node.name.getText(ast)) && node.initializer && ts.isCallExpression(node.initializer))
    callbacks[node.name.getText(ast)] = node.initializer.arguments[0].getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);
if (Object.keys(callbacks).length !== 2) throw new Error("Admission callback missing");
const code = ts.transpileModule(Object.entries(callbacks).map(([name, callback]) => `globalThis.${name} = ${callback};`).join("\n"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
afterEach(() => useSessionsStore.getState().clearAll());

describe("transcript presentation during session reattachment", () => {
  it.each(["claude", "codex", "cursor"].flatMap(agent => ["loadIntoChat", "ensureSession"].map(action => [agent, action])))(
    "retains exact %s transcript presentation during %s for each placement", async (agentId, action) => {
    for (const cwd of ["/personal/project", "/organization/project", "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222"]) {
      const cloud = isCloudWorkspace(cwd), chatId = "chat";
      const messages = [{ id: "prior", kind: "text" as const, role: "agent" as const, text: "Prior output", createdAt: 1 }];
      const presentation = cloud ? { source: "cache" as const } : null;
      useSessionsStore.getState().setSession(chatId, { ...BLANK, cwd, agentId, messages, transcriptState: cloud ? "loading" : "resident",
        transcriptPresentation: presentation });
      const generations = new Map<string, number>();
      let release!: (id: string) => void;
      const workspace = new Promise<string>(resolve => { release = resolve; });
      const context: Record<string, unknown> = { BLANK, isCloudWorkspace, cancelGeneration, cancelledSince, executionActorForRecovery, admissionRouteWithoutFlight,
        getStore: useSessionsStore.getState, bridge: {}, ensureInFlightRef: { current: new Map() },
        loadFlightAdoptOnlyRef: { current: new Map() }, loadFlightKeysRef: { current: new Map() }, cancelGenerationsRef: { current: generations },
        loadIntoChatRef: { current: null }, ENSURE_SESSION_ATTEMPTS: 1, ENSURE_SESSION_BACKOFF_MS: [0],
        resolveSpawnCwd: () => cwd, getProviderBinaryOverride: () => undefined,
        resolveSpawnWorkspaceId: () => workspace, evictUnretainedTranscripts: vi.fn() };
      vm.runInNewContext(code, context);
      const load = context[action] as (...args: unknown[]) => Promise<unknown>;
      const loading = action === "loadIntoChat" ? load(chatId, agentId, null, { cwd }) : load(chatId, agentId, { cwd, force: true });
      const pending = useSessionsStore.getState().sessions[chatId];
      // Cancel and settle the held real callback before assertions so failures
      // cannot leave a provider admission promise behind in the test worker.
      generations.set(chatId, 1); release("workspace"); await loading;
      expect(pending.messages).toBe(messages);
      expect(pending.transcriptPresentation).toBe(presentation);
      expect(pending.transcriptState).toBe(cloud ? "loading" : "resident");
    }
  });
});
