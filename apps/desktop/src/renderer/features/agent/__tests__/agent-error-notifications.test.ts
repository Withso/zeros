import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import type { AgentFailure } from "../../../platform/bridge/failure";
import { isRecoverable, isTransportShaped } from "../../../platform/bridge/failure";
import { isCloudWorkspace } from "../../../platform/bridge/cloud-workspace-key";
import { turnCheckpointsAvailable } from "../chat-feature-availability";
import { turnFailureForCard } from "../turn-failure";
import { groupMessagesIntoTurns } from "../turn-grouping";
import { tailTurnInFlight } from "../tail-indicators";

// Execute the actual chat notification effect, with only React scheduling and
// external sinks supplied. The unrelated editor/native tree is not mounted.
const source = ts.createSourceFile("agent-chat.tsx", readFileSync(new URL("../agent-chat.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let effectSource = "", noticeSource = "", legacyLabelSource = "";
function visit(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === "labelForFailure") legacyLabelSource = node.getText(source);
  if (ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration =>
    ["preparationTurn", "preparationTurnRead", "preparationTurnFailure", "preparationFailure"].includes(declaration.name.getText(source))))
    noticeSource += node.getText(source) + "\n";
  if (ts.isBlock(node)) {
    const index = node.statements.findIndex(statement => ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(declaration => /^lastError.*Ref$/.test(declaration.name.getText(source))));
    if (index >= 0) effectSource = node.statements.slice(index, index + 2).map(statement => statement.getText(source)).join("\n");
  }
  ts.forEachChild(node, visit);
}
visit(source);
if (!effectSource.includes("useEffect")) throw new Error("Chat failure boundary missing");
// Replay the prior toast implementation too: absence of the inline notice must
// fail a behavioral assertion, not prevent the regression suite from loading.
const script = new vm.Script(ts.transpileModule(`${legacyLabelSource}\n${effectSource}\n${noticeSource || "const preparationFailure = null;"}\npreparationFailure;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText);
const cloud = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
const protocol = (detail: string): AgentFailure => ({ kind: "protocol-error", stage: "newSession", agentId: "cursor", message: detail });

function mounted(folder: string, history?: { status: string; stopReason?: string; readOnly?: boolean; localNote?: boolean }) {
  const refs: Array<{ current: unknown }> = [];
  const toast = { error: vi.fn() }, warn = vi.fn(), localRefresh = vi.fn(), cloudRefresh = vi.fn();
  let session = { agentId: "cursor", agentName: "Cursor", status: "ready", error: null as string | null,
    failure: null as AgentFailure | null, cloudSendWait: null };
  const render = (next: Partial<typeof session> = {}, interactive = true, chatId = "chat", account = 1) => {
    session = { ...session, ...next };
    let index = 0;
    return script.runInNewContext({ session, chatId, interactive, chatThread: { folder }, cloudComputerV2: true,
      isErrorState: ["failed", "auth-required"].includes(session.status), isTransportShaped, isRecoverable, isCloudWorkspace, turnCheckpointsAvailable,
      readOnly: history?.readOnly ?? false,
      turns: history ? groupMessagesIntoTurns([
        { id: "earlier-prompt", kind: "text", role: "user", text: "Earlier request", createdAt: 1,
          ...(history.localNote ? { localNote: {
            chatId: "worker", title: "Worker", agentId: "codex", link: "zeros-dev://chat/worker",
            event: "done" as const, status: "completed",
          } } : {}),
        },
        { id: "earlier-answer", kind: "text", role: "agent", text: "Earlier answer", createdAt: 2 },
      ]) : [],
      detachedCloudAdmission: null, provisionalTranscript: false, surfaceActive: interactive,
      pendingLocalTurnId: null, isStreaming: false, tailTurnInFlight, turnFailureForCard,
      turnRowCache: {}, turnRowKey: () => "fixture-turn", turnGet: vi.fn(),
      useCachedRead: (_cache: unknown, key: string | null) => ({ data: key ? history ?? null : null }),
      cloudCatalogGeneration: () => account,
      toast, console: { warn },
      useRef: (initial: unknown) => refs[index++] ?? (refs[index - 1] = { current: initial }),
      useEffect: (run: () => void) => run(),
      invalidateAgentsCache: localRefresh, refreshAgents: async () => {}, agentSessions: { listAgents: vi.fn() },
      invalidateCloudAgentRegistry: cloudRefresh, warmCloudAgentRegistry: async () => {},
    });
  };
  return { render, toast: toast.error, warn, localRefresh, cloudRefresh };
}

describe("agent failure notification ownership", () => {
  it.each(["/local/personal", "/organization/local", cloud])("does not replay a retained failure on mount or remount of %s", folder => {
    const failure = protocol("synthetic retained fault");
    for (let mount = 0; mount < 2; mount++) {
      const view = mounted(folder);
      view.render({ status: "failed", failure });
      expect(view.toast).not.toHaveBeenCalled();
      expect(view.warn).not.toHaveBeenCalled();
    }
  });

  it.each(["/local/personal", "/organization/local", cloud])("keeps new startup failures inline without toasts in %s", folder => {
    const view = mounted(folder);
    view.render();
    expect(view.render({ status: "failed", failure: protocol("synthetic fault A") })?.message).toBe("synthetic fault A");
    view.render();
    view.render({}, false);
    view.render({}, true);
    expect(view.toast).not.toHaveBeenCalled();
    expect(view.render({ failure: protocol("synthetic fault B") })?.message).toBe("synthetic fault B");
    expect(view.toast).not.toHaveBeenCalled();
    expect(view.warn).not.toHaveBeenCalled();
  });

  describe.each(["/local/personal", "/organization/local", cloud])("startup failure with history in %s", folder => {
    it.each(["completed", "cancelled"])("shows one explanation after a %s turn", status => {
      for (const stage of ["initialize", "loadSession"] as const) {
        const view = mounted(folder, { status, stopReason: status === "cancelled" ? "cancelled" : "end_turn" });
        const failure = { ...protocol("The provider executable is unavailable."), stage };
        view.render();
        expect(view.render({ status: "failed", failure })?.message).toBe(failure.message);
        expect(view.toast).not.toHaveBeenCalled();
        expect(turnFailureForCard({ events: [], turnId: "earlier-prompt", fallback: failure, status })).toBeNull();
        expect(view.render({ status: "ready", failure: null })).toBeNull();
      }
    });

    it("leaves an unfinished turn's failure to its existing card", () => {
      const view = mounted(folder, { status: "failed" });
      const failure = { ...protocol("The provider could not initialize."), stage: "initialize" as const };
      expect(view.render({ status: "failed", failure })).toBeNull();
      expect(turnFailureForCard({ events: [], turnId: "earlier-prompt", fallback: failure, status: "failed" })?.message).toBe(failure.message);
      expect(view.toast).not.toHaveBeenCalled();
    });

    it("leaves a failed Local notification turn's explanation to its footer", () => {
      const view = mounted(folder, { status: "failed", localNote: true });
      const failure = { ...protocol("The provider could not initialize."), stage: "initialize" as const };
      expect(view.render({ status: "failed", failure })).toBeNull();
      expect(turnFailureForCard({ events: [], turnId: "earlier-prompt", fallback: failure, status: "failed" })?.message).toBe(failure.message);
      expect(view.toast).not.toHaveBeenCalled();
    });

    it.each(["completed", "cancelled"])("shows a later startup failure after a %s Local notification turn", status => {
      const view = mounted(folder, { status, localNote: true });
      const failure = { ...protocol("The provider could not initialize."), stage: "initialize" as const };
      expect(view.render({ status: "failed", failure })?.message).toBe(failure.message);
    });

    it("keeps read-only history and recoverable startup failures quiet", () => {
      const failure = protocol("Synthetic startup failure");
      expect(mounted(folder, { status: "completed", readOnly: true }).render({ status: "failed", failure })).toBeNull();
      for (const kind of ["transport-closed", "lifecycle-superseded", "timeout", "auth-required", "cloud-credentials-unavailable"] as const) {
        expect(mounted(folder, { status: "completed" }).render({ status: "failed", failure: { ...failure, kind } })).toBeNull();
      }
    });
  });

  it("does not turn hidden or foreign-owner failure state into a notification", () => {
    const view = mounted(cloud);
    view.render();
    view.render({ status: "failed", failure: protocol("hidden") }, false);
    view.render({}, true);
    view.render({ failure: protocol("foreign") }, true, "other-chat");
    expect(view.toast).not.toHaveBeenCalled();
  });

  it("does not replay an unchanged serialized failure during live revalidation", () => {
    const view = mounted(cloud), failure = protocol("one failed outcome");
    view.render();
    view.render({ status: "failed", failure });
    view.render({ failure: { ...failure } });
    expect(view.toast).not.toHaveBeenCalled();
    view.render({ status: "warming", failure: null });
    view.render({ status: "failed", failure: { ...failure } });
    expect(view.toast).not.toHaveBeenCalled();
  });

  it("ignores a retained same-chat error across account A to B to A", () => {
    const view = mounted(cloud);
    view.render();
    view.render({ status: "failed", failure: protocol("account B fault") }, true, "chat", 2);
    view.render({ failure: protocol("old account A fault") }, true, "chat", 3);
    expect(view.toast).not.toHaveBeenCalled();
  });

  it.each(["lifecycle-superseded", "transport-closed", "timeout", "session-expired"] as const)("keeps %s quiet even if a caller supplied failed status", kind => {
    const view = mounted("/local/personal");
    view.render();
    expect(view.render({ status: "failed", failure: { ...protocol("closed cancellation"), kind } })).toBeNull();
    expect(view.toast).not.toHaveBeenCalled();
  });

  it.each(["/local/personal", "/organization/local", cloud])("refreshes auth only for the failure's owning placement %s", folder => {
    const view = mounted(folder);
    view.render();
    view.render({ status: "auth-required", failure: { ...protocol("synthetic expired connection"), kind: "auth-required" } });
    expect(view.toast).not.toHaveBeenCalled();
    expect(view.localRefresh).toHaveBeenCalledTimes(folder === cloud ? 0 : 1);
    expect(view.cloudRefresh).toHaveBeenCalledTimes(folder === cloud ? 1 : 0);
    if (folder === cloud) expect(view.cloudRefresh).toHaveBeenCalledWith(folder);
    view.render();
    expect(view.localRefresh.mock.calls.length + view.cloudRefresh.mock.calls.length).toBe(1);
  });

  // Execute the owning effect instead of requiring the former Local-only
  // refresh statement layout in composer-responsive-contract.test.ts.
  it.each(["/local/personal", "/organization/local", cloud])("does not revalidate any provider after a non-auth failure in %s", folder => {
    const view = mounted(folder);
    view.render();
    view.render({ status: "failed", failure: protocol("synthetic initialization fault") });
    expect(view.localRefresh).not.toHaveBeenCalled();
    expect(view.cloudRefresh).not.toHaveBeenCalled();
  });

  it("leaves prompt failures and their advice to the turn notice", () => {
    const view = mounted("/local/personal");
    view.render();
    view.render({ status: "failed", failure: { ...protocol("prompt fault"), stage: "prompt" } });
    expect(view.toast).not.toHaveBeenCalled();
    view.render({ failure: { ...protocol("prompt fault with action"), stage: "prompt", advice: "Choose another model." } });
    expect(view.toast).not.toHaveBeenCalled();
  });
});
