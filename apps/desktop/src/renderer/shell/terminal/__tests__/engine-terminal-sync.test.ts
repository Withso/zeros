import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { isCloudWorkspace } from "../../../platform/bridge/cloud-workspace-key";
import { WorkspaceRuntimeClient } from "../../../platform/bridge/workspace-runtime-client";
import { selectExcludedChatTerminalIds, selectPanelTerminals } from "../terminal-registry-sync";

const source = ts.createSourceFile("terminal-tab.tsx", readFileSync(new URL("../../workbench/tabs/terminal-tab.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const hook = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "useEngineTerminalSync");
if (!hook) throw new Error("Terminal registry hook missing");
const code = ts.transpileModule(hook.getText(source) + "\nglobalThis.hook = useEngineTerminalSync;", {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const folder = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
function harness(client: WorkspaceRuntimeClient, owner: string | null = null) {
  let effect!: () => void | (() => void), changed!: () => void;
  const sync = vi.fn(), engine = vi.spyOn(client, "cloudEngineInstanceId").mockReturnValue("first-engine");
  const context: any = {
    useTerminalStore: (select: (state: object) => unknown) => select({ syncEngineTerminals: sync }),
    useWorkspaceStore: (select: (state: object) => unknown) => select({ chats: [{ id: "chat", kind: "chat", organizationId: owner }] }),
    useShallow: (select: unknown) => select, useState: () => [null, vi.fn()],
    useEffect: (fn: typeof effect) => { effect = fn; }, getActiveBridge: vi.fn(() => client),
    WorkspaceRuntimeClient, isCloudWorkspace, selectExcludedChatTerminalIds, selectPanelTerminals,
    ptyTerminals: vi.fn(async () => []), onPtyTerminalsChanged: vi.fn((fn: () => void) => { changed = fn; return () => {}; }),
    onActiveBridgeConnected: vi.fn(() => () => {}),
  };
  vm.runInNewContext(code, context);
  return { context, sync, engine, run: (key: string, active = true) => { context.hook(key, active); return effect(); }, changed: () => changed() };
}
describe("terminal registry ownership", () => {
  it.each([null, "organization"])("keeps Local owner %s on the original three-argument sync without reading cloud identity", async owner => {
    const client = new WorkspaceRuntimeClient({ open: vi.fn(), workspaces: () => [] }), h = harness(client, owner);
    const cleanup = h.run("/local/worktree");
    await vi.waitFor(() => expect(h.sync).toHaveBeenCalledExactlyOnceWith("/local/worktree", [], []));
    expect(h.context.ptyTerminals).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(h.context.getActiveBridge).not.toHaveBeenCalled(); expect(h.engine).not.toHaveBeenCalled();
    cleanup?.(); client.dispose();
  });
  it("fences an old registry response after engine replacement and tags the fresh registry", async () => {
    const client = new WorkspaceRuntimeClient({ open: vi.fn(), workspaces: () => [] }), h = harness(client);
    let finish!: (value: unknown[]) => void;
    h.context.ptyTerminals.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const cleanup = h.run(folder); h.engine.mockReturnValue("resumed-engine"); finish([]);
    await Promise.resolve(); await Promise.resolve(); expect(h.sync).not.toHaveBeenCalled();
    h.changed();
    await vi.waitFor(() => expect(h.sync).toHaveBeenCalledExactlyOnceWith(folder, [], [], "resumed-engine"));
    cleanup?.(); client.dispose();
  });
  it("keeps a hidden retained controller inert for either placement", () => {
    const client = new WorkspaceRuntimeClient({ open: vi.fn(), workspaces: () => [] }), h = harness(client);
    h.run(folder, false); h.run("/local/worktree", false);
    expect(h.context.ptyTerminals).not.toHaveBeenCalled(); expect(h.context.getActiveBridge).not.toHaveBeenCalled();
    expect(h.context.onActiveBridgeConnected).not.toHaveBeenCalled(); client.dispose();
  });
});
