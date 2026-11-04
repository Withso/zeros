import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { beforeEach, expect, it, vi } from "vitest";
import { cloudScopedId, cloudWorkspaceKey, isCloudWorkspace } from "../../../platform/bridge/cloud-workspace-key";
import { BLANK, useSessionsStore } from "../sessions-store";

const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const folder = cloudWorkspaceKey(target), cloudId = cloudScopedId(target, "chat");
const ast = ts.createSourceFile("agent-chat.tsx", readFileSync(new URL("../agent-chat.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let source = "";
(function collect(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "editAndResubmit" && node.initializer && ts.isCallExpression(node.initializer))
    source = node.initializer.arguments[0]!.getText(ast);
  ts.forEachChild(node, collect);
})(ast);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function harness(cwd = folder) {
  const chatId = isCloudWorkspace(cwd) ? cloudId : "local-chat";
  const messages = [{ id: "old", kind: "text" as const, role: "user" as const, text: "old", createdAt: 1 }];
  useSessionsStore.getState().setSession(chatId, { ...BLANK, cwd, messages });
  const send = vi.fn(async () => {}), truncate = vi.fn(async () => {}), toast = { error: vi.fn(), warning: vi.fn() };
  const encodeAttachments = vi.fn(async () => ({ blocks: [], bubbleAttachments: [], bubbleAttachmentById: new Map(), skipped: [] }));
  let current = true;
  const dispose = vi.fn();
  const context = { chatId, chatThread: { folder: cwd }, transcriptReadOnly: false, useSessionsStore, isCloudWorkspace,
    session: { cwd, agentId: "codex", status: "ready", sendPrompt: send }, encodeAttachments, toast,
    trackCloudChatMutation: () => ({ isCurrent: () => current, dispose }),
    recordWorkspaceActivity: vi.fn(), reportSkippedAttachments: vi.fn(), toMessageSegments: () => [],
    ipcTruncateMessagesFrom: truncate, pendingSendScrollCountRef: { current: 0 } };
  const edit = vm.runInNewContext(ts.transpileModule(`(${source})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context) as (id: string, text: string, attachments: unknown[]) => Promise<unknown>;
  return { edit: () => edit("old", "edited", []), send, truncate, toast, encodeAttachments, dispose,
    retire: () => { current = false; }, rows: () => useSessionsStore.getState().sessions[chatId]?.messages, messages };
}
beforeEach(() => useSessionsStore.getState().clearAll());

it.each(["CLOUD_V2_UNSUPPORTED", "bridge closed", "request timed out"])("retains the cloud transcript and never sends after an uncertain/refused truncate: %s", async reason => {
  const h = harness(); h.truncate.mockRejectedValueOnce(new Error(reason));
  await h.edit();
  expect(h.send).not.toHaveBeenCalled();
  expect(h.rows()).toEqual(h.messages);
  expect(h.toast.error).toHaveBeenCalled();
});

it.each([folder, "/personal/repo", "/organization/repo"])("sends once only after confirmed history truncation in %s", async cwd => {
  const h = harness(cwd), held = deferred<void>();
  h.truncate.mockImplementationOnce(() => held.promise);
  const edit = h.edit(); await vi.waitFor(() => expect(h.truncate).toHaveBeenCalledOnce());
  expect(h.send).not.toHaveBeenCalled();
  held.resolve(); await edit;
  expect(h.send).toHaveBeenCalledOnce();
  expect(h.rows()).toEqual([]);
});

it.each(["attachments", "truncate"])("does not send or mutate a replacement owner after a held %s boundary", async boundary => {
  const h = harness(), held = deferred<void>(), ready = deferred<void>();
  if (boundary === "attachments") h.encodeAttachments.mockImplementationOnce(async () => {
    ready.resolve(); await held.promise; return { blocks: [], bubbleAttachments: [], bubbleAttachmentById: new Map(), skipped: [] };
  });
  else h.truncate.mockImplementationOnce(async () => { ready.resolve(); await held.promise; });
  const edit = h.edit(); await ready.promise; h.retire(); held.resolve(); await edit;
  expect(h.send).not.toHaveBeenCalled();
  expect(h.rows()).toEqual(h.messages);
  if (boundary === "attachments") expect(h.truncate).not.toHaveBeenCalled();
});
