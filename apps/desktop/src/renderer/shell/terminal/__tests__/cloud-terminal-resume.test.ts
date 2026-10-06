import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { isCloudWorkspace, parseCloudWorkspaceKey } from "../../../platform/bridge/cloud-workspace-key";

const source = readFileSync(new URL("../terminal-session-view.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("view.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations: string[] = [];
function collect(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && ["canResumeCloudTerminal", "spawn", "resumeAfterReconnect"].includes(node.name.text))
    declarations.push(`const ${node.getText(ast)};`);
  ts.forEachChild(node, collect);
}
collect(ast);
const code = ts.transpileModule(declarations.join("\n") + "\nglobalThis.actions = {spawn, resumeAfterReconnect};", {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const folder = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
function harness(cwd = folder, engine = "new-engine", visible = true) {
  const term = { write: vi.fn(), writeln: vi.fn(), focus: vi.fn() };
  const row = { id: "shell", resumePending: true };
  const context: any = {
    term, sessionId: "shell", cwd, visible, visibleRef: { current: visible }, xtermRef: { current: term },
    attachInFlightRef: { current: false }, createdRef: { current: true }, spawnStartedRef: { current: true },
    reconnectPendingRef: { current: true }, exitedRef: { current: false }, restartBlockedRef: { current: false },
    engineInstanceRef: { current: "old-engine" }, cloudTerminalEngineId: () => engine,
    lastDimsRef: { current: { cols: 80, rows: 24 } }, agentLaunchedRef: { current: true }, restartOnKeyRef: { current: true },
    attachOnly: false, ephemeral: false, loginProvider: undefined, initialCommand: undefined, agentId: null, replayOnMiss: undefined,
    ptyTerminals: vi.fn(async () => []), ptyCreate: vi.fn(async () => ({ cols: 80, rows: 24, reattached: false })), ptyResize: vi.fn(),
    setReadPending: vi.fn(), setReadFailure: vi.fn(), setHasScrollback: vi.fn(), markExited: vi.fn(), markAlive: vi.fn(),
    useTerminalStore: { getState: () => ({ sessions: [row] }) }, isCloudWorkspace, parseCloudWorkspaceKey, managed: true,
    cloudWorkspaceDocument: () => ({ status: "ready", capabilities: { canWrite: true }, deletedAt: null, error: null }),
  };
  vm.runInNewContext(code, context);
  context.row = row;
  return context;
}
describe("cloud terminal resume", () => {
  it("spawns a fresh shell in the existing cwd and writes one dim resume line after engine replacement", async () => {
    const h = harness(); await h.actions.spawn(h.term, true);
    expect(h.ptyCreate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sessionId: "shell", cwd: folder }));
    expect(h.term.writeln).toHaveBeenCalledExactlyOnceWith("\r\n\x1b[2mWorkspace resumed — new shell\x1b[0m");
    expect(h.markExited).not.toHaveBeenCalled(); expect(h.setReadFailure).not.toHaveBeenCalledWith(expect.any(Error));
  });
  it("keeps a same-engine closed shell exited without automatically recreating it", async () => {
    const h = harness(folder, "old-engine"); h.row.resumePending = false;
    await h.actions.spawn(h.term, true);
    expect(h.ptyCreate).not.toHaveBeenCalled(); expect(h.markExited).toHaveBeenCalledWith("shell");
  });
  it("keeps hidden retained terminals inert until shown", async () => {
    const h = harness(folder, "new-engine", false); h.actions.resumeAfterReconnect();
    await Promise.resolve(); expect(h.ptyTerminals).not.toHaveBeenCalled(); expect(h.ptyCreate).not.toHaveBeenCalled();
  });
  it.each(["Personal", "organization"])("preserves %s Local missing-shell reconnect behavior", async () => {
    const h = harness("/local/worktree"); await h.actions.spawn(h.term, true);
    expect(h.ptyCreate).not.toHaveBeenCalled(); expect(h.markExited).toHaveBeenCalledWith("shell");
    expect(h.term.writeln).toHaveBeenCalledWith(expect.stringContaining("press any key to restart"));
    expect(h.term.writeln).not.toHaveBeenCalledWith(expect.stringContaining("Workspace resumed"));
  });
  it("never respawns a missing cloud Run PTY as a shell", async () => {
    const h = harness(); h.attachOnly = true; await h.actions.spawn(h.term, true);
    expect(h.ptyCreate).not.toHaveBeenCalled(); expect(h.markExited).toHaveBeenCalledWith("shell");
  });
  it("waits for compute readiness without a read, shell or error, then resumes after a shell-exit event", async () => {
    const h = harness(); const doc = { status: "waking", capabilities: { canWrite: true }, deletedAt: null, error: null };
    h.cloudWorkspaceDocument = () => doc; h.exitedRef.current = true;
    await h.actions.spawn(h.term, true);
    expect(h.ptyTerminals).not.toHaveBeenCalled(); expect(h.ptyCreate).not.toHaveBeenCalled(); expect(h.setReadFailure).not.toHaveBeenCalled();
    doc.status = "ready"; h.actions.resumeAfterReconnect();
    await vi.waitFor(() => expect(h.ptyCreate).toHaveBeenCalledOnce());
    expect(h.term.writeln).toHaveBeenCalledExactlyOnceWith("\r\n\x1b[2mWorkspace resumed — new shell\x1b[0m");
  });
  it("reattaches a shell already resumed on another device without writing a second resume line", async () => {
    const h = harness(); h.ptyTerminals.mockResolvedValue([{ sessionId: "shell", exited: false }]);
    h.ptyCreate.mockResolvedValue({ cols: 80, rows: 24, reattached: true, replay: "Remote shell" });
    await h.actions.spawn(h.term, true);
    expect(h.ptyCreate).toHaveBeenCalledOnce(); expect(h.term.writeln).not.toHaveBeenCalled();
    expect(h.term.write).toHaveBeenCalledExactlyOnceWith("\x1bcRemote shell");
  });
  it.each(["hidden", "stopped", "archived", "access"])("does not create a resumed shell if the tab becomes %s during registry discovery", async cause => {
    const h = harness(); const doc = { status: "ready", capabilities: { canWrite: true }, deletedAt: null, error: null };
    h.cloudWorkspaceDocument = () => doc;
    let finish!: (terms: unknown[]) => void;
    h.ptyTerminals.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const pending = h.actions.spawn(h.term, true);
    if (cause === "hidden") h.visibleRef.current = false;
    else if (cause === "access") doc.capabilities.canWrite = false;
    else doc.status = cause;
    finish([]); await pending;
    expect(h.ptyCreate).not.toHaveBeenCalled(); expect(h.setReadFailure).not.toHaveBeenCalledWith(expect.any(Error));
  });
});
