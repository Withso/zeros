import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { INITIAL_PRISTINE_SPAWN_BIND, nextPristineSpawnDecision } from "../pristine-agent-switch";
import { deferBootSessionAdmission } from "../lazy-boot-resume";

// Run the real ChatView effects at the session boundary, including the order
// after hydration. Persistence is independent and has not saved chats.upsert.
const ast = ts.createSourceFile("chat-view.tsx", readFileSync(new URL("../chat-view.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const effects: Record<string, string> = {};
function visit(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === "useEffect") {
    const effect = node.arguments[0]?.getText(ast) ?? "";
    if (effect.includes("await session.hydrateChat()")) effects.open = effect;
    if (effect.includes("const prev = lastBridgeStatusRef.current")) effects.reconnect = effect;
  }
  ts.forEachChild(node, visit);
}
visit(ast);
if (!effects.open || !effects.reconnect) throw new Error("ChatView admission effects missing");
const code = ts.transpileModule(Object.entries(effects).map(([name, source]) => `globalThis.${name} = ${source};`).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const CLOUD = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";

function setup(cwd: string) {
  const chatId = "first-chat", chat = { id: chatId, folder: cwd, agentId: "claude", title: "Untitled" };
  const slot = { sessionId: null, status: "reconnecting", hasTranscript: false, messages: [] };
  const order: string[] = [];
  const session = { ...slot, hydrateChat: vi.fn(async () => { order.push("hydrate"); }),
    ensureSession: vi.fn(async () => { order.push("create"); }) };
  const sessions = { getSession: () => slot, loadIntoChat: vi.fn(async () => { order.push("probe"); return false; }) };
  const context = vm.createContext({ session, sessions, chat, chatId, agentId: "claude", agentName: "Claude", cwd,
    readOnly: false, surfaceActive: true, pendingAutoSend: false, preparing: false, workspaceProvisioning: false,
    navigationOnly: false, isFocusedChat: true, composerHasText: false, envKey: "", envKeyRef: { current: "" },
    bindRef: { current: { chatId, bind: INITIAL_PRISTINE_SPAWN_BIND } }, bridgeStatus: "connected",
    lastBridgeStatusRef: { current: "disconnected" }, nextPristineSpawnDecision, deferBootSessionAdmission,
    hasUntitledChatName: () => true, envForChat: () => undefined, setHistoryError: vi.fn(), dispatch: vi.fn() });
  vm.runInContext(code, context);
  return { context, session, sessions, order, chatId };
}

describe("first default conversation before its metadata save", () => {
  it.each(["/personal/repo", "/organization/repo", CLOUD])("creates the same first chat after hydrate at %s", async cwd => {
    const h = setup(cwd);
    const cleanup = (h.context.open as () => () => void)();
    try {
      await vi.waitFor(() => expect(h.session.ensureSession).toHaveBeenCalledOnce());
      expect(h.order).toEqual(["hydrate", "create"]);
      expect(h.sessions.loadIntoChat).not.toHaveBeenCalled();
      expect(h.context.dispatch).not.toHaveBeenCalled();
    } finally { cleanup(); }
  });

  it("a reconnect probe miss creates the original cloud chat, without a new tab", async () => {
    const h = setup(CLOUD);
    const cleanup = (h.context.reconnect as () => () => void)();
    try {
      await vi.waitFor(() => expect(h.session.ensureSession).toHaveBeenCalledOnce());
      expect(h.order).toEqual(["probe", "create"]);
      expect(h.sessions.loadIntoChat).toHaveBeenCalledWith(h.chatId, "claude", null, expect.objectContaining({ cwd: CLOUD }));
      expect(h.context.dispatch).not.toHaveBeenCalled();
    } finally { cleanup(); }
  });
});
