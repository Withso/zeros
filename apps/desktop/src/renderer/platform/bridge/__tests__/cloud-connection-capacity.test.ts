import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceRuntimeClient, type CloudPeer } from "../workspace-runtime-client";
import { cloudWorkspaceKey, type CloudWorkspaceTarget } from "../cloud-workspace-key";
import type { RuntimeClient } from "../ws-client";

/** A connected fake runtime per open. `retire` delivers a terminal rejection;
 * `release` records that the client gave the transport back. */
function harness(liveWork: (target: CloudWorkspaceTarget) => boolean = () => false) {
  const peers = new Map<string, { retire: () => void; release: ReturnType<typeof vi.fn> }>();
  const open = vi.fn(async (target: CloudWorkspaceTarget) => {
    const listeners = new Set<(status: string) => void>();
    const release = vi.fn();
    const runtime = {
      status: "connected", lastRejection: undefined as unknown,
      request: async (message: { op?: string }) => ({ type: "WORKSPACE_RESPONSE", op: message.op, result: { chats: [], chatDeletions: [] } }),
      on: () => () => {},
      onStatusChange: (callback: (status: string) => void) => { listeners.add(callback); return () => listeners.delete(callback); },
    };
    peers.set(target.workspaceId, { release, retire: () => {
      runtime.status = "disconnected";
      runtime.lastRejection = { reason: "cloud-unavailable" };
      for (const listener of listeners) listener("disconnected");
    } });
    return { client: runtime as unknown as RuntimeClient, scope: { ...target, root: "/workspace/repo", engineWorkspaceId: target.workspaceId }, release } as CloudPeer;
  });
  const client = new WorkspaceRuntimeClient({ open, workspaces: () => [], canAccess: () => true, liveWork });
  return { client, open, peers };
}
const target = (index: number): CloudWorkspaceTarget => ({
  organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: `${String(index).padStart(8, "0")}-2222-4222-8222-222222222222`,
});
const clients: WorkspaceRuntimeClient[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.dispose(); });

describe("cloud connection capacity", () => {
  it("admits a seventeenth workspace after sixteen earlier connections retired", async () => {
    const { client, open, peers } = harness();
    clients.push(client);
    for (let index = 1; index <= 16; index++) {
      await client.openWorkspace(target(index));
      peers.get(target(index).workspaceId)!.retire();
    }
    await expect(client.openWorkspace(target(17))).resolves.toBeUndefined();
    expect(open).toHaveBeenCalledTimes(17);
  });

  it("releases the least recently used idle connection, keeping its history, to admit a seventeenth", async () => {
    const { client, peers } = harness();
    clients.push(client);
    for (let index = 1; index <= 16; index++) await client.openWorkspace(target(index));
    await client.openWorkspace(target(1));
    await expect(client.openWorkspace(target(17))).resolves.toBeUndefined();
    expect(peers.get(target(2).workspaceId)!.release).toHaveBeenCalledOnce();
    expect(peers.get(target(1).workspaceId)!.release).not.toHaveBeenCalled();
    expect(client.hasChatSnapshot(cloudWorkspaceKey(target(2)))).toBe(true);
  });

  it("reconnects a released workspace on its next explicit open", async () => {
    const { client, open } = harness();
    clients.push(client);
    for (let index = 1; index <= 17; index++) await client.openWorkspace(target(index));
    const before = open.mock.calls.length;
    await expect(client.openWorkspace(target(1))).resolves.toBeUndefined();
    expect(open.mock.calls.length).toBe(before + 1);
  });

  it("never releases a workspace with live work and refuses without asking for a restart", async () => {
    let busy = true;
    const { client, peers } = harness(() => busy);
    clients.push(client);
    for (let index = 1; index <= 16; index++) await client.openWorkspace(target(index));
    const refusal = await client.openWorkspace(target(17)).then(() => null, (error: unknown) => error);
    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).not.toMatch(/reopen zeros/i);
    for (let index = 1; index <= 16; index++) expect(peers.get(target(index).workspaceId)!.release).not.toHaveBeenCalled();
    busy = false;
    await expect(client.openWorkspace(target(17))).resolves.toBeUndefined();
  });
});
