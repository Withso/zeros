import { afterEach, expect, it, vi } from "vitest";
import { createContextAttachmentWriter } from "../agent-history-client";
import { setActiveBridge } from "../../../platform/bridge/active-bridge";
import { WorkspaceRuntimeClient, type CloudPeer } from "../../../platform/bridge/workspace-runtime-client";
import type { RuntimeClient } from "../../../platform/bridge/ws-client";
import { cloudWorkspaceKey } from "../../../platform/bridge/cloud-workspace-key";
import { createWorkspaceMediaReader } from "../../../platform/files";
import { offerPendingFilePreview, acquirePendingFilePreview } from "../../../platform/pending-file-preview";

const clients: WorkspaceRuntimeClient[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.dispose(); setActiveBridge(null); });
const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const cwd = cloudWorkspaceKey(target);
const args = { cwd, attachmentId: "clip", filename: "clip.mp4", mimeType: "video/mp4", uploadId: "transfer", totalBytes: 500_000_000, offset: 0, base64: "" };
function fixture() {
  const state = { account: "account-a", generation: 7, stopVersion: 0 };
  const request = vi.fn(async (message: Record<string, unknown>) => ({ type: "WORKSPACE_RESPONSE", op: message.op,
    result: message.op === "file.readRange" ? { bytes: 1, base64: "AQ==" } : message.op === "chats.list" ? { chats: [], chatDeletions: [] }
      : { bytes: 0, pending: true, absolutePath: "", relativePath: "", mimeType: "video/mp4" } }));
  const peer = { client: { status: "connected", request, on: () => () => {}, onStatusChange: () => () => {} } as unknown as RuntimeClient,
    scope: { ...target, root: "/home/user/owner/workspace", engineWorkspaceId: target.workspaceId }, release: vi.fn() } satisfies CloudPeer;
  const open = vi.fn<() => Promise<CloudPeer>>(async () => peer);
  const client = new WorkspaceRuntimeClient({ open, workspaces: () => [], canAccess: () => true,
    identity: () => `${state.account}:${state.generation}`, wakeOwner: () => ({ ...state }) });
  clients.push(client); setActiveBridge(client);
  return { state, request, open, client, peer };
}

it("wakes a stopped cloud destination before upload and allows its expected wake generation", async () => {
  const { open, request, state, client, peer } = fixture(), write = createContextAttachmentWriter(cwd);
  let release!: (peer: CloudPeer) => void;
  open.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const first = write(args);
  await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
  state.generation++; client.pruneCloudConnections();
  release({ ...peer, generation: state.generation });
  await first; await write({ ...args, base64: "AQ==" });
  expect(open).toHaveBeenCalledOnce();
  expect(open).toHaveBeenCalledWith(expect.objectContaining(target), expect.objectContaining({ wake: true, reason: "interaction" }));
  expect(request.mock.calls.filter(([message]) => message.op === "attachment.write")).toHaveLength(2);
});

it.each(["stop", "account", "generation"])("fences attachment chunks after %s changes, including account A → B → A", async change => {
  const { state, request, client } = fixture(), write = createContextAttachmentWriter(cwd);
  await write(args);
  const calls = request.mock.calls.length;
  if (change === "stop") state.stopVersion++;
  else if (change === "generation") state.generation++;
  else {
    state.account = "account-b"; client.clearCloudConnections();
    state.account = "account-a"; client.clearCloudConnections();
  }
  await expect(write({ ...args, base64: "AQ==" })).rejects.toThrow(/workspace changed/);
  expect(request.mock.calls).toHaveLength(calls);
});

it("keeps local previews through wake but refuses media ranges and preview leases from a retired account", async () => {
  const { client, request } = fixture();
  const finish = offerPendingFilePreview(cwd, "clip.mp4", new Blob(["clip"]));
  await createContextAttachmentWriter(cwd)(args);
  const preview = acquirePendingFilePreview(cwd, "clip.mp4")!;
  expect(preview.bytes).toBe(4); preview.release();
  const reader = createWorkspaceMediaReader(cwd), range = { path: "clip.mp4", version: "1:2:3", offset: 0, length: 1 };
  await expect(reader(range)).resolves.toMatchObject({ bytes: 1 });
  const calls = request.mock.calls.length;
  client.clearCloudConnections();
  expect(acquirePendingFilePreview(cwd, "clip.mp4")).toBeNull();
  await expect(reader(range)).rejects.toThrow(/workspace changed/);
  expect(request.mock.calls).toHaveLength(calls);
  finish();
});
