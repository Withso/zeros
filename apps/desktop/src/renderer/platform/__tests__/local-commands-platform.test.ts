import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ device: null as null | { deviceId: string; headers: Record<string, string> }, invokes: [] as Array<{ cmd: string; args?: unknown }>,
  reply: undefined as unknown }));
vi.mock("../runtime", async original => ({ ...await original<typeof import("../runtime")>(), isElectron: () => true,
  nativeInvoke: async (cmd: string, args?: unknown) => { state.invokes.push({ cmd, args }); return cmd === "local_commands_device" ? state.device : state.reply; },
  nativeListen: async () => () => {} }));
vi.mock("../../features/auth/auth-store", () => ({ getSession: async () => ({ access_token: "synthetic-session", user: { sub: "u", accountId: "55555555-5555-4555-8555-555555555555" } }) }));
vi.mock("../../features/team/team-store", () => ({ getOrganizationStoreGeneration: () => 0 }));
vi.mock("../../features/team/control-plane", () => ({ CONTROL_PLANE_URL: "https://api.example.test", ControlPlaneError: class extends Error {} }));
import { cloudPromptApi } from "../cloud-prompt-api";
import { connectThisMac, decideLocalCommand, isDecidingLocalCommand, listWorkspaceMacs, readLocalCommandsEnabled, resetLocalCommandApprovalsForTests, writeLocalCommandsEnabled } from "../local-commands";

const ws = "11111111-1111-4111-8111-111111111111", org = "22222222-2222-4222-8222-222222222222";
const deviceId = "7f1f6c1e-3b0a-4f7e-9d43-8a0b2b9c6d11";
const headers = { "X-Zeros-Device-Id": deviceId, "X-Zeros-Device-Registration": "8f1f6c1e-3b0a-4f7e-9d43-8a0b2b9c6d12", "X-Zeros-Device-Instance": "9f1f6c1e-3b0a-4f7e-9d43-8a0b2b9c6d13" };
const iso = "2026-11-10T12:00:00.000Z";
let fetches: Array<{ url: string; init: RequestInit }> = [];
const respond = (body: unknown) => vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => { fetches.push({ url, init }); return Response.json(body); }));
beforeEach(() => { state.device = null; state.invokes = []; state.reply = undefined; fetches = []; resetLocalCommandApprovalsForTests(); });
afterEach(() => vi.unstubAllGlobals());

describe("local commands in the renderer", () => {
  const receipt = { workspaceId: ws, chatId: "chat", userMessageId: "user-1", epoch: "1", sequence: "1", acceptedAt: iso, workspaceState: "running" };
  const payload = { chatId: "chat", userMessageId: "user-1", agentId: "codex", startedAt: 1, prompt: [{ type: "text", text: "hi" }] };
  it("sends this Mac's three device headers with a prompt, and none when it is not registered", async () => {
    respond({ receipt });
    state.device = { deviceId, headers };
    await cloudPromptApi({ organizationId: org, workspaceId: ws }, "chat").enqueue(payload as never);
    const sent = new Headers(fetches[0]!.init.headers);
    expect([sent.get("x-zeros-device-id"), sent.get("x-zeros-device-registration"), sent.get("x-zeros-device-instance")]).toEqual(Object.values(headers));
    state.device = null;
    await cloudPromptApi({ organizationId: org, workspaceId: ws }, "chat").enqueue(payload as never);
    expect(new Headers(fetches[1]!.init.headers).get("x-zeros-device-id")).toBeNull();
    state.device = { deviceId, headers: { "X-Zeros-Device-Id": deviceId } };
    await cloudPromptApi({ organizationId: org, workspaceId: ws }, "chat").enqueue(payload as never);
    expect(new Headers(fetches[2]!.init.headers).get("x-zeros-device-id")).toBeNull();
  });

  it("relays one decision per request to main", async () => {
    const id = "a1111111-1111-4111-8111-111111111111";
    await Promise.all([decideLocalCommand(id, "yes"), decideLocalCommand(id, "deny")]);
    expect(state.invokes.filter(call => call.cmd === "local_commands_decide")).toEqual([{ cmd: "local_commands_decide", args: { requestId: id, decision: "yes" } }]);
    expect(isDecidingLocalCommand(id)).toBe(true);
  });

  it("reads Macs and the organization switch from their routes, and connects through main", async () => {
    const mac = { deviceId, name: "Studio", connected: true, active: true, reachable: true, expiresAt: null };
    respond({ macs: [mac] });
    expect(await listWorkspaceMacs(ws)).toEqual([mac]);
    expect(fetches[0]!.url).toBe(`https://api.example.test/v1/cloud-v2/workspaces/${ws}/macs`);
    respond({ localCommandsEnabled: false });
    expect(await readLocalCommandsEnabled(org)).toBe(false);
    await writeLocalCommandsEnabled(org, true);
    expect(fetches.at(-1)).toMatchObject({ url: `https://api.example.test/v1/cloud-v2/organizations/${org}/local-commands`, init: { method: "PUT", body: JSON.stringify({ localCommandsEnabled: true }) } });
    state.reply = { mac, presence: { presenceRequired: true, reachableUntil: iso } };
    expect((await connectThisMac(ws)).mac.active).toBe(true);
    expect(state.invokes.at(-1)).toEqual({ cmd: "local_commands_connect", args: { workspaceId: ws } });
  });
});
