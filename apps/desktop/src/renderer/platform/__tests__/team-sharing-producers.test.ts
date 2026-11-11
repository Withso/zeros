import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../features/auth/auth-store", () => ({ getSession: async () => ({ access_token: "synthetic-session", user: { sub: "u" } }) }));
vi.mock("../../features/team/team-store", () => ({ getOrganizationStoreGeneration: () => 0, getTeamStoreState: () => ({ me: null }), subscribeOrganizationSnapshots: () => () => {} }));
vi.mock("../../features/team/control-plane", () => ({ CONTROL_PLANE_URL: "https://api.example.test", ControlPlaneError: class extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); } } }));
vi.mock("../local-commands", () => ({ localCommandDevice: async () => ({ headers: {
  "X-Zeros-Device-Id": "7f1f6c1e-3b0a-4f7e-9d43-8a0b2b9c6d11", "X-Zeros-Device-Registration": "8f1f6c1e-3b0a-4f7e-9d43-8a0b2b9c6d12", "X-Zeros-Device-Instance": "9f1f6c1e-3b0a-4f7e-9d43-8a0b2b9c6d13" } }) }));
import { changeCloudV2Workspace, connectCloudV2Workspace, editCloudV2Chat, getCloudV2Workspace, pingCloudV2WorkspaceActivity, readCloudV2History, renameCloudV2Workspace } from "../cloud-v2";
import { cloudPromptApi } from "../cloud-prompt-api";
import { CloudWorkspaceReadOnlyError } from "../cloud-workspace-read-only";
import { registerSharingRoleLookup, subscribeWorkspaceReadOnly } from "../team-sharing-state";

const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const doc = { id: target.workspaceId, organizationId: target.organizationId, creatorUserId: "44444444-4444-4444-8444-444444444444", name: "w", repository: "Withso/zeros",
  branch: "zeros/w", baseBranch: "main", state: "stopped", errorCode: null, archivedAt: null, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", version: 2,
  capabilities: { design: false, browser: false, simulators: false, terminal: true, files: true, git: true, agents: ["codex"] } };
const receipt = { workspaceId: target.workspaceId, chatId: "chat", userMessageId: "33333333-3333-4333-8333-333333333333", epoch: "1", state: "queued", acceptedAt: 1 };
let calls: Array<{ url: string; headers: Headers; signal?: AbortSignal | null }> = [];
let reply: (url: string) => Response;
beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => { calls.push({ url, headers: new Headers(init.headers), signal: init.signal }); return reply(url); }));
});
afterEach(() => vi.unstubAllGlobals());

describe("the Team sharing opt-in follows the viewer's role in the document held", () => {
  const respondAll = () => {
    reply = url => Response.json(/\/history$/.test(url) ? { result: { chats: [] } } : /\/connect/.test(url) ? { url: "wss://x.example.test/v2", protocols: ["zeros.cloud.v2", `ticket.zw2c_${"a".repeat(43)}`], expiresAt: "2026-11-11T00:00:00Z" }
      : /\/edit$/.test(url) ? { chat: { id: "chat", title: "T", archived: false } } : /\/activity$/.test(url) ? { running: true }
      : /\/prompts\/stop$/.test(url) ? { chatId: "chat", throughEpoch: "1", stopped: [] } : /\/prompts\?/.test(url) ? { epoch: "0", items: [], nextAfter: null }
      : /\/prompts$/.test(url) ? { receipt } : /\/github$/.test(url) ? {} : { workspace: doc });
  };
  const exercise = async (signal?: AbortSignal) => {
    await readCloudV2History(target, "chats.list", {});
    await connectCloudV2Workspace(target, { wake: true, ...(signal ? { signal } : {}) });
    for (const action of ["start", "stop", "restart", "archive", "delete"] as const) await changeCloudV2Workspace(target, action).catch(() => {});
    await editCloudV2Chat(target, "chat", { title: "T" });
    await pingCloudV2WorkspaceActivity(target);
    const prompts = cloudPromptApi(target, "chat");
    await prompts.enqueue({ chatId: "chat", userMessageId: receipt.userMessageId, agentId: "codex", startedAt: 1, prompt: [{ type: "text", text: "Hi" }] } as never).catch(() => {});
    await prompts.list("0", true).catch(() => {});
    await prompts.stop("1").catch(() => {});
  };
  const paths = () => calls.map(call => new URL(call.url).pathname.replace(/^\/v1\/cloud-v2\/workspaces\/[^/]+/, ""));
  const headers = () => calls.map(call => call.headers.get("x-zeros-team-sharing"));
  let role: string | undefined;
  beforeEach(() => { role = undefined; registerSharingRoleLookup(id => (id === target.workspaceId ? role : undefined)); respondAll(); });

  it("sends today's requests, with no opt-in, for the Creator and for a document without sharing fields", async () => {
    for (const held of ["creator", undefined]) {
      calls = []; role = held;
      await exercise();
      expect(paths()).toEqual(["/history", "/connect", "/start", "/stop", "/restart", "/archive", "", "/chats/chat/edit", "/activity", "/prompts", "/prompts", "/prompts/stop"]);
      expect(headers()).toEqual(calls.map(() => null));
    }
  });

  it("opts in for an admin's or member's history, receipts, lifecycle, chat edits and execution attempts, keeping each request's options", async () => {
    for (const held of ["admin", "member"]) {
      calls = []; role = held;
      const signal = new AbortController().signal;
      await exercise(signal);
      expect(headers()).toEqual(calls.map(() => "1"));
      expect(calls[9]!.headers.get("x-zeros-device-id")).toBe("7f1f6c1e-3b0a-4f7e-9d43-8a0b2b9c6d11");
      expect(calls[1]!.signal).not.toBeNull();
    }
  });

  it("always opts in on the sharing-only messages.senders lookup, for the Creator too, while the Creator's other history stays headerless", async () => {
    for (const held of ["creator", undefined, "member"]) {
      calls = []; role = held;
      reply = () => Response.json({ result: { senders: {} } });
      await readCloudV2History(target, "messages.senders", { chatId: "chat", userMessageIds: ["m1"] });
      await readCloudV2History(target, "messages.window", { chatId: "chat", limit: 100 });
      expect(headers(), String(held)).toEqual(["1", held === "member" ? "1" : null]);
    }
  });

  it("always opts in on discovery and sharing-only routes", async () => {
    role = "creator";
    reply = url => Response.json(/\/rename$/.test(url) ? { workspace: doc, teamSharing: 1 } : { workspace: doc });
    await getCloudV2Workspace(target);
    await renameCloudV2Workspace(target, "Renamed");
    expect(headers()).toEqual(["1", "1"]);
  });

  it("maps 409 workspace_read_only to the read-only error and reports the workspace, so its document is read again", async () => {
    reply = () => Response.json({ error: { code: "workspace_read_only", message: "This workspace is read-only for you" } }, { status: 409 });
    const reported: string[] = [];
    const stop = subscribeWorkspaceReadOnly(id => reported.push(id));
    registerSharingRoleLookup(() => "member");
    const error = await connectCloudV2Workspace(target, { wake: true }).catch(e => e);
    expect(error).toBeInstanceOf(CloudWorkspaceReadOnlyError);
    expect(error).toMatchObject({ status: 409, code: "workspace_read_only" });
    await expect(changeCloudV2Workspace(target, "start")).rejects.toBeInstanceOf(CloudWorkspaceReadOnlyError);
    expect(reported).toEqual([target.workspaceId, target.workspaceId]);
    stop();
  });

});
