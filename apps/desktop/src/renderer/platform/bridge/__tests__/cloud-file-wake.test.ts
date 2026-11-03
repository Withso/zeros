import { afterEach, expect, it, vi } from "vitest";
import { writeWorkspaceFile } from "../../files";
import { setActiveBridge } from "../active-bridge";
import { cloudWorkspaceKey } from "../cloud-workspace-key";
import { WorkspaceRuntimeClient, type CloudPeer, type WorkspaceRuntimeOptions } from "../workspace-runtime-client";
import type { RuntimeClient } from "../ws-client";

const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const clients: WorkspaceRuntimeClient[] = [];
afterEach(() => { setActiveBridge(null); for (const client of clients.splice(0)) client.dispose(); });

function fixture() {
  let running = false, finish!: (peer: CloudPeer) => void;
  const ready = new Promise<CloudPeer>(resolve => { finish = resolve; });
  const request = vi.fn(async (message: { op: string }) => ({ type: "WORKSPACE_RESPONSE", op: message.op,
    result: message.op === "file.write" ? { kind: "success", path: "draft.txt", bytes: 5 } : { chats: [] } }));
  const peer: CloudPeer = { scope: { ...target, root: "/workspace/repo", engineWorkspaceId: target.workspaceId }, release: vi.fn(),
    client: { request, status: "connected", on: () => () => {}, onStatusChange: () => () => {} } as unknown as RuntimeClient };
  const open = vi.fn<WorkspaceRuntimeOptions["open"]>(async (_target, options) => {
    if (running) return peer;
    if (options?.wake) return ready;
    throw new Error("The cloud workspace is stopped");
  });
  const client = new WorkspaceRuntimeClient({ open, workspaces: () => [], canReuseForWork: () => running });
  clients.push(client); setActiveBridge(client);
  return { client, request, open, run: () => { running = true; finish(peer); }, stop: () => { running = false; } };
}

it("rejects a stopped cloud file save promptly as a transport error without creating a wake", async () => {
  const { open } = fixture();
  await expect(writeWorkspaceFile(cloudWorkspaceKey(target), "draft.txt", "draft")).rejects.toThrow("stopped");
  expect(open).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(target), expect.not.objectContaining({ wake: true }));
});

it("joins the interaction wake before sending a cloud file save and preserves its result", async () => {
  const { client, request, open, run } = fixture();
  const waking = client.openWorkspace(target, { reason: "interaction" });
  const save = writeWorkspaceFile(cloudWorkspaceKey(target), "draft.txt", "draft");
  expect(request).not.toHaveBeenCalled();
  run();
  await waking;
  await expect(save).resolves.toEqual({ kind: "success", path: "draft.txt", bytes: 5 });
  expect(open).toHaveBeenCalledOnce();
  expect(open).toHaveBeenCalledWith(target, expect.objectContaining({ wake: true, reason: "interaction" }));
  expect(request.mock.calls.filter(([message]) => message.op === "file.write")).toHaveLength(1);
});

it("never sends an autosave retry over a retained socket after the VM stops", async () => {
  const { client, request, open, run, stop } = fixture();
  run(); await client.warmWorkspace(target); request.mockClear();
  stop();
  await expect(writeWorkspaceFile(cloudWorkspaceKey(target), "draft.txt", "draft")).rejects.toThrow("stopped");
  expect(request.mock.calls.some(([message]) => message.op === "file.write")).toBe(false);
  expect(open.mock.calls.every(([, options]) => !options?.wake)).toBe(true);
});
