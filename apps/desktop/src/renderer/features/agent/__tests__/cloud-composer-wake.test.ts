import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { isCloudWorkspace, parseCloudWorkspaceKey } from "../../../platform/bridge/cloud-workspace-key";
import { isSubmittedComposerDocument } from "../composer-submission";
import { sendSessionRecoveryMode } from "../session-reload-lifecycle";

// Exercise the actual composer entry points without unrelated React surfaces,
// like the provider's queue-workflow harness. In particular, a stopped cloud
// workspace is still classified as provisioning by useWorkspaceProvisioning.
const source = readFileSync(new URL("../agent-chat.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("composer.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations: string[] = [];
function collect(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && ["runSend", "handleSend"].includes(node.name.text))
    declarations.push(`const ${node.getText(ast)};`);
  ts.forEachChild(node, collect);
}
collect(ast);
const code = ts.transpileModule(declarations.join("\n") + "\nglobalThis.handleSend = handleSend;", {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function harness(status = "stopped", enabled = true) {
  const folder = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
  const draft = { displayText: "Inspect this attachment", json: { text: "Inspect this attachment", attachment: "image" },
    attachments: [{ id: "image", kind: "image" }], segments: [{ type: "text", text: "Inspect this attachment" }] };
  let generation = 0, currentStatus = status;
  let ready!: () => void;
  let fail!: (error: Error) => void;
  const pending = new Promise<void>((resolve, reject) => { ready = resolve; fail = reject; });
  const prepare = vi.fn(() => pending);
  const clear = vi.fn(), dispatch = vi.fn(), startSession = vi.fn(async () => {}), sendPrompt = vi.fn(async () => {});
  const state = { sessions: { chat: { transcriptState: "resident" } } };
  const context: Record<string, unknown> = {
    chatId: "chat", readOnly: false, cloudComputerV2: enabled, workspaceProvisioning: status !== "ready",
    chatThread: { id: "chat", folder, agentId: "codex" },
    session: { transcriptState: "resident", status: "reconnecting", agentId: "codex", startSession, sendPrompt },
    agentSessions: { getSendGeneration: () => generation, prepareForSend: prepare },
    cloudWorkspaceDocument: () => ({ status: currentStatus }), parseCloudWorkspaceKey,
    designFrameContext: { capture: () => null, pin: vi.fn() },
    hasPendingTextAttachmentDelivery: () => false, transcriptAttachesRef: { current: new Set() },
    useSessionsStore: { getState: () => state },
    useWorkspaceStore: { getState: () => ({ pendingAutoSend: {} }) },
    transcriptParkedChatRef: { current: null }, serializeComposerState: () => draft,
    sendPastPermission: () => "send", planReview: null, bareInlineSlashCommand: () => null,
    composerLiveRef: { current: null }, dispatch, recordWorkspaceActivity: vi.fn(),
    agentsList: null, sendSessionRecoveryMode, envForChat: () => ({}),
    isCloudWorkspace, setCloudSendPreparing: vi.fn(), setSendPreparing: vi.fn(),
    encodeComposerAttachments: vi.fn(async () => ({ blocks: [], bubbleAttachments: [{ name: "image" }], bubbleAttachmentById: new Map(), skipped: [] })),
    expandMentionsInText: (text: string) => text, browserPickerSelection: null,
    reportSkippedAttachments: vi.fn(), toMessageSegments: () => draft.segments, isSubmittedComposerDocument,
    clearComposer: clear, pendingSendScrollCountRef: { current: 0 }, sendInFlightRef: { current: false },
    startCloudSubmitSpan: () => vi.fn(), toast: { error: vi.fn(), warning: vi.fn(), info: vi.fn() },
  };
  vm.runInNewContext(code, context);
  return { context, prepare, clear, dispatch, startSession, sendPrompt, draft,
    send: context.handleSend as () => Promise<void>,
    ready: () => { currentStatus = "ready"; ready(); }, fail, stop: () => { generation++; },
  };
}

describe("message wake before the provisioning queue", () => {
  it("wakes a stopped workspace before ordinary admission and submits a repeated Enter once", async () => {
    const h = harness();
    const first = h.send(), duplicate = h.send();
    expect(h.prepare).toHaveBeenCalledExactlyOnceWith("chat");
    expect(h.startSession).not.toHaveBeenCalled();
    expect(h.sendPrompt).not.toHaveBeenCalled();
    expect(h.clear).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "REQUEST_AUTO_SEND" }));
    h.ready(); await Promise.all([first, duplicate]);
    expect(h.startSession).toHaveBeenCalledOnce();
    expect(h.sendPrompt).toHaveBeenCalledOnce();
    expect(h.clear).toHaveBeenCalledOnce();
  });

  it.each(["cancel", "failure"])("retains the rich draft and avoids admission on wake %s", async reason => {
    const h = harness(), before = structuredClone(h.draft);
    const sending = h.send();
    expect(h.prepare).toHaveBeenCalledOnce();
    if (reason === "cancel") { h.stop(); h.ready(); }
    else h.fail(new Error("Sponsor denied wake"));
    await sending;
    expect(h.draft).toEqual(before);
    expect(h.clear).not.toHaveBeenCalled();
    expect(h.startSession).not.toHaveBeenCalled();
    expect(h.sendPrompt).not.toHaveBeenCalled();
  });

  it.each(["gate", "new fork"])("preserves the existing provisioning queue for %s", async reason => {
    const h = harness(reason === "new fork" ? "provisioning" : "stopped", reason !== "gate");
    await h.send();
    expect(h.prepare).not.toHaveBeenCalled();
    expect(h.dispatch).toHaveBeenCalledWith({ type: "REQUEST_AUTO_SEND", chatId: "chat" });
    expect(h.clear).not.toHaveBeenCalled();
  });
});
