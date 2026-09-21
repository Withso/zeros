import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZerosEngine } from "../zeros-engine";
import { closeZerosDb, setZerosDbPathForTesting } from "../db";
import { getChat, setChatComposerMode } from "../db/chats";

const prototype = ZerosEngine.prototype as unknown as {
  handleConnect(this: unknown, client: { id: string; kind: string; send: (message: unknown) => void }): Promise<void>;
  handleCloudCommandOperation(this: unknown, op: string, params: Record<string, unknown>): Promise<unknown>;
  validateCloudCommand(this: unknown, conversationId: string, payload?: unknown): void;
};
let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-cloud-conversation-")); setZerosDbPathForTesting(path.join(directory, "state.db")); });
afterEach(() => { closeZerosDb(); setZerosDbPathForTesting(null); fs.rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const root = path.join(directory, "workspace"); fs.mkdirSync(root);
  const engine = { root, cloudCommands: { handle: vi.fn() }, broadcast: vi.fn(), validateCloudCommand: prototype.validateCloudCommand,
    workspace: { resolveReadCwd: vi.fn((id: string) => { if (id !== "local-main") throw new Error("unknown workspace"); return root; }),
      workspaceIdForCwd: () => "local-main", handle: vi.fn(async (_op: string, params: { chatId: string; mode: "code" | "design"; expectedRevision: number }) =>
        setChatComposerMode(params.chatId, params.mode, params.expectedRevision)) } };
  const call = (op: string, params: Record<string, unknown>) => prototype.handleCloudCommandOperation.call(engine, "cloudCommands." + op, params);
  return { engine, call };
}
describe("portable cloud conversations", () => {
  it("advertises the durable command contract during the successful handshake", async () => {
    const { engine } = fixture(), send = vi.fn();
    await prototype.handleConnect.call({ ...engine, framework: "unknown", actualPort: 1234 }, { id: "device", kind: "cloud", send });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "ENGINE_READY", capabilities: ["cloud.commands.v1"], root: "" }));
  });
  it("creates and reads an idempotent conversation using only opaque workspace identity", async () => {
    const { engine, call } = fixture();
    const input = { conversationId: "chat", workspaceId: "local-main", agentId: "claude" };
    expect(await call("createConversation", input)).toEqual({ conversationId: "chat", workspaceId: "local-main", agentId: "claude", mode: "code", modeRevision: 0 });
    await call("createConversation", input);
    expect(getChat("chat")?.folder).toBe(engine.root);
    expect(JSON.stringify(await call("conversation", { conversationId: "chat" }))).not.toContain(engine.root);
    await expect(call("createConversation", { ...input, agentId: "cursor" })).rejects.toMatchObject({ code: "command_conflict" });
  });
  it("rejects client paths and stale mode changes before overwriting another device", async () => {
    const { call } = fixture();
    await expect(call("createConversation", { conversationId: "chat", workspaceId: "local-main", agentId: "claude", folder: "/private" })).rejects.toMatchObject({ code: "invalid_command" });
    expect(getChat("chat")).toBeNull();
    await call("createConversation", { conversationId: "chat", workspaceId: "local-main", agentId: "claude" });
    expect(await call("setMode", { conversationId: "chat", mode: "design", expectedRevision: 0 })).toMatchObject({ mode: "design", modeRevision: 1 });
    await expect(call("setMode", { conversationId: "chat", mode: "code", expectedRevision: 0 })).rejects.toThrow(/changed/);
    await expect(call("setMode", { conversationId: "chat", mode: "code" })).rejects.toMatchObject({ code: "invalid_command" });
    expect(getChat("chat")?.composerMode).toBe("design");
  });
});
