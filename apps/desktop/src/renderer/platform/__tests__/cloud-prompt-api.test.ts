import { afterEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ generation: 1 }));
vi.mock("../../features/auth/auth-store", () => ({ getSession: async () => ({ access_token: "synthetic-session" }) }));
vi.mock("../../features/team/team-store", () => ({ getOrganizationStoreGeneration: () => state.generation }));
vi.mock("../../features/team/control-plane", () => ({ CONTROL_PLANE_URL: "https://api.example.test", ControlPlaneError: class extends Error {} }));
import { cloudPromptApi } from "../cloud-prompt-api";
import { cloudAccountRequest } from "../cloud-workspaces";
import { z } from "zod";
const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const payload = { chatId: "chat", userMessageId: "one", agentId: "codex" as const, prompt: [{ type: "text" as const, text: "ok" }], startedAt: 1 };
const receipt = { workspaceId: target.workspaceId, chatId: "chat", userMessageId: "one", sequence: "1", epoch: "0", acceptedAt: new Date(1).toISOString(), workspaceState: "running" };
afterEach(() => { vi.unstubAllGlobals(); state.generation = 1; });
it("sends the frozen id over HTTPS and never calls connect or wake", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ receipt })); vi.stubGlobal("fetch", fetch);
  const api = cloudPromptApi(target, "chat"); await api.enqueue(payload); await api.enqueue(payload);
  expect(fetch.mock.calls.map(call => call[0])).toEqual(Array(2).fill(`https://api.example.test/v1/cloud-v2/workspaces/${target.workspaceId}/prompts`));
  expect(fetch.mock.calls[0]![1]).toMatchObject({ method: "POST", body: JSON.stringify(payload), cache: "no-store" });
});
it("bounds recovery separately from ordinary APIs and requests payload-free polling", async () => {
  const big = { epoch: "0", items: [{ receipt, state: "queued", cancelRequested: false,
    payload: { ...payload, prompt: [{ type: "text", text: "x".repeat(5 * 1024 * 1024) }] } }], nextAfter: null };
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(big)); vi.stubGlobal("fetch", fetch);
  const api = cloudPromptApi(target, "chat"); expect((await api.list("0", true)).items).toHaveLength(1);
  await expect(cloudAccountRequest("/v1/ordinary", z.unknown())).rejects.toThrow(/size limit/i);
  fetch.mockImplementation(async () => Response.json({ epoch: "0", items: [], nextAfter: null }));
  await api.list("4", false); expect(fetch.mock.calls.at(-1)?.[0]).toContain("includePayload=false");
});
it("rejects a foreign receipt and any reply from a retired account", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ receipt: { ...receipt, workspaceId: target.organizationId } })));
  await expect(cloudPromptApi(target, "chat").enqueue(payload)).rejects.toThrow(/identity|conversation/i);
  vi.stubGlobal("fetch", vi.fn(async () => { state.generation++; return Response.json({ receipt }); }));
  await expect(cloudPromptApi(target, "chat").enqueue(payload)).rejects.toThrow(/account changed/i);
});
