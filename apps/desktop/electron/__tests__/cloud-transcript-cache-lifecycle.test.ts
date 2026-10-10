import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ user: { accountId: "account-a", sub: "a", provider: "workos", sessionId: "a" },
  listeners: [] as Array<() => void>, retain: vi.fn(), write: vi.fn() }));
vi.mock("electron", () => ({ app: { getPath: () => "/synthetic/cache-test" } }));
vi.mock("../ipc/commands/auth-session", () => ({ getSessionUserForMain: () => h.user,
  onMainAuthSessionChanged: (fn: () => void) => { h.listeners.push(fn); return () => {}; } }));
vi.mock("../cloud-transcript-cache-store", () => ({ CloudTranscriptCacheStore: class {
  retainAccount = h.retain; write = h.write;
  readReceipt = () => ({ historyEpoch: "33333333-3333-4333-8333-333333333333", window: null });
} }));
const source = ts.createSourceFile("command-registry.ts", readFileSync(new URL("../ipc/commands/command-registry.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const registration = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "registerAllCommands")!;
beforeEach(() => { vi.resetModules(); h.user = { accountId: "account-a", sub: "a", provider: "workos", sessionId: "a" }; h.listeners = []; h.retain.mockReset(); h.write.mockReset(); });
describe("optional cloud cache lifecycle at Local startup", () => {
  it("registers Personal/org-Local commands and the auth listener when initial cache cleanup throws", async () => {
    const lifecycle = await import("../ipc/commands/cloud-transcript-cache");
    h.retain.mockImplementation(() => { throw new Error("Synthetic disk unavailable"); });
    const commands = new Map<string, unknown>(), context: Record<string, unknown> = {};
    for (const node of source.statements) if (ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
      for (const name of node.importClause.namedBindings.elements) context[name.name.text] = vi.fn();
    }
    Object.assign(context, lifecycle, { setCommand: (name: string, handler: unknown) => commands.set(name, handler) });
    vm.runInNewContext(ts.transpileModule(`${registration.getText(source).replace(/^export /u, "")}\nglobalThis.register = registerAllCommands;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
    expect(() => (context.register as () => void)()).not.toThrow();
    expect(commands.has("get_engine_port")).toBe(true); expect(commands.has("git_list_files")).toBe(true);
    expect(h.listeners).toHaveLength(1);
  });
  it("fences old cache receipts and remains unavailable until failed retirement is purged", async () => {
    const lifecycle = await import("../ipc/commands/cloud-transcript-cache");
    lifecycle.installCloudTranscriptCacheLifecycle();
    const owner = { accountId: "account-a", organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222", chatId: "chat-a" };
    const event = {} as Parameters<typeof lifecycle.cloudTranscriptCacheRead>[1];
    const receipt = lifecycle.cloudTranscriptCacheRead(owner, event) as { cacheEpoch: string };
    h.retain.mockImplementation(() => { throw new Error("Synthetic disk unavailable"); });
    h.user = { ...h.user, accountId: "account-b", sessionId: "b" }; h.listeners[0]!();
    expect(() => lifecycle.cloudTranscriptCacheRead({ ...owner, accountId: "account-b" }, event)).toThrow();
    h.user = { ...h.user, accountId: "account-a", sessionId: "a-new" }; h.listeners[0]!();
    expect(() => lifecycle.cloudTranscriptCacheRead(owner, event)).toThrow();
    h.retain.mockReset();
    const fresh = lifecycle.cloudTranscriptCacheRead(owner, event) as { cacheEpoch: string };
    expect(fresh.cacheEpoch).not.toBe(receipt.cacheEpoch);
    expect(h.retain).toHaveBeenCalledWith(null);
    expect(() => lifecycle.cloudTranscriptCacheWrite({ ...owner, cacheEpoch: receipt.cacheEpoch,
      window: { recordEpoch: null, revision: 1, cursor: null, messages: [] } }, event)).toThrow(/owner changed/u);
    expect(h.write).not.toHaveBeenCalled();
  });
});
