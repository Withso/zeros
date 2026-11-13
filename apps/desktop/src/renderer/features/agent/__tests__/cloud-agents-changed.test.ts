import { describe, expect, it, vi } from "vitest";
import { cloudWorkspaceKey } from "../../../platform/bridge/cloud-workspace-key";
import { watchCloudAgentsChanged } from "../cloud-agents-changed";

const a = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const b = { ...a, workspaceId: "33333333-3333-4333-8333-333333333333" };
function bridge() {
  const handlers = new Set<(message: unknown) => void>();
  return { on: (_type: string, handler: (message: unknown) => void) => { handlers.add(handler); return () => handlers.delete(handler); },
    emit: (message: unknown) => { for (const handler of handlers) handler(message); }, handlers };
}

describe("§ activated model picker: the worker's DB_CHANGED agents signal", () => {
  it("re-lists that workspace's agents and re-reads the model list of its open chats only", () => {
    const fake = bridge(), invalidate = vi.fn(), refresh = vi.fn();
    const sessions = { "chat-a": { cwd: cloudWorkspaceKey(a) }, "chat-a-sub": { cwd: `${cloudWorkspaceKey(a)}/packages/app` },
      "chat-b": { cwd: cloudWorkspaceKey(b) }, local: { cwd: "/repo/local" } };
    const stop = watchCloudAgentsChanged(fake, { sessions: () => sessions, invalidate, refresh });
    fake.emit({ type: "DB_CHANGED", kinds: ["agents"], workspaceIds: [cloudWorkspaceKey(a)] });
    expect(invalidate).toHaveBeenCalledExactlyOnceWith(cloudWorkspaceKey(a));
    expect(refresh.mock.calls.map(([chatId]) => chatId).sort()).toEqual(["chat-a", "chat-a-sub"]);
    stop(); expect(fake.handlers.size).toBe(0);
  });

  it("ignores other kinds, Local folders and malformed signals", () => {
    const fake = bridge(), invalidate = vi.fn(), refresh = vi.fn();
    watchCloudAgentsChanged(fake, { sessions: () => ({ "chat-a": { cwd: cloudWorkspaceKey(a) } }), invalidate, refresh });
    fake.emit({ type: "DB_CHANGED", kinds: ["chats"], workspaceIds: [cloudWorkspaceKey(a)] });
    fake.emit({ type: "DB_CHANGED", kinds: ["agents"], workspaceIds: ["/repo/local"] });
    fake.emit({ type: "DB_CHANGED", kinds: ["agents"] });
    fake.emit({ type: "DB_CHANGED", kinds: "agents", workspaceIds: [cloudWorkspaceKey(a)] });
    expect(invalidate).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled();
  });
});
