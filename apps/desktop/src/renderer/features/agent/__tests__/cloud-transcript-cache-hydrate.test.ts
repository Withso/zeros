import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cloudScopedId, parseCloudScopedId, isCloudWorkspace } from "../../../platform/bridge/cloud-workspace-key";
import { BLANK, useSessionsStore } from "../sessions-store";
import { reconcileHistoryMessages } from "../history-message-identity";
import { seedPersistedMessageRefs } from "../message-persistence-tracker";
import { isCurrentTranscriptRequest, releaseTranscriptRequest } from "../transcript-retention";
import type { AgentMessage } from "../use-agent-session";
const ast = ts.createSourceFile("sessions-provider.tsx", readFileSync(new URL("../sessions-provider.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback = "";
function collect(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "hydrateChat" && node.initializer && ts.isCallExpression(node.initializer)) callback = node.initializer.arguments[0]!.getText(ast);
  ts.forEachChild(node, collect);
}
collect(ast);
const code = ts.transpileModule(`globalThis.hydrate = ${callback};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const cloudId = cloudScopedId(target, "chat-a");
const message = (text: string): AgentMessage => ({ id: "m-1", kind: "text", role: "agent", text, createdAt: 1 });
function harness(chatId = cloudId) {
  let resolve!: (rows: AgentMessage[]) => void;
  const server = new Promise<AgentMessage[]>(done => { resolve = done; });
  const history = vi.fn((_id: string, _limit: number, _before?: number, onCached?: (rows: AgentMessage[]) => void) => {
    queueMicrotask(() => onCached?.([message("cached")])); return server;
  });
  const requests = new Map<string, Promise<void>>();
  const context: Record<string, unknown> = { console: { warn: vi.fn() }, BLANK, parseCloudScopedId, isCloudWorkspace, cloudComputerV2: true,
    HYDRATE_WINDOW: 200, reconcileHistoryMessages, seedPersistedMessageRefs, isCurrentTranscriptRequest, releaseTranscriptRequest,
    getStore: useSessionsStore.getState, bridge: { status: "connected" }, reconcileChatMessages: vi.fn(), persistWindowMessages: history,
    hydrateInFlightRef: { current: requests }, pendingHydratesRef: { current: new Set() }, persistedMessageRefsRef: { current: new Map() } };
  vm.runInNewContext(code, context);
  return { resolve, requests, history, hydrate: context.hydrate as (id: string) => Promise<void>, chatId };
}
beforeEach(() => { useSessionsStore.setState({ sessions: {} }); });
describe("production initial transcript hydration", () => {
  it("paints cached cloud rows before the server resolves, then replaces them atomically", async () => {
    const h = harness(), result = h.hydrate(h.chatId);
    await Promise.resolve();
    expect(useSessionsStore.getState().sessions[h.chatId]?.messages).toEqual([message("cached")]);
    expect(useSessionsStore.getState().sessions[h.chatId]?.transcriptState).toBe("loading");
    h.resolve([message("new server")]); await result;
    expect(useSessionsStore.getState().sessions[h.chatId]?.messages).toEqual([message("new server")]);
    expect(useSessionsStore.getState().sessions[h.chatId]?.transcriptState).toBe("resident");
  });
  it("keeps newer runtime-streamed messages when the older projection finishes", async () => {
    const h = harness(), result = h.hydrate(h.chatId); await Promise.resolve();
    useSessionsStore.getState().patchSession(h.chatId, { messages: [message("live stream")], transcriptState: "resident", status: "streaming" });
    h.resolve([message("older projection")]); await result;
    expect(useSessionsStore.getState().sessions[h.chatId]?.messages).toEqual([message("live stream")]);
  });
  it("cannot resurrect a slot retired during account switch or apply into a replacement request", async () => {
    const h = harness(), result = h.hydrate(h.chatId);
    h.requests.delete(h.chatId); useSessionsStore.getState().removeSession(h.chatId);
    await Promise.resolve(); h.resolve([message("old account")]); await result;
    expect(useSessionsStore.getState().sessions[h.chatId]).toBeUndefined();
  });
  it("leaves Personal Local and organization Local hydration on the authoritative path", async () => {
    for (const folder of ["/personal/checkout", "/organization/checkout"]) {
      const h = harness("local-chat"); useSessionsStore.getState().setSession(h.chatId, { ...BLANK, cwd: folder, transcriptState: "cold" });
      const result = h.hydrate(h.chatId); await Promise.resolve();
      expect(h.history.mock.calls[0]?.[3]).toBeUndefined();
      expect(useSessionsStore.getState().sessions[h.chatId]?.messages).toEqual([]);
      h.resolve([message("local disk")]); await result;
      expect(useSessionsStore.getState().sessions[h.chatId]?.messages).toEqual([message("local disk")]);
    }
  });
});
