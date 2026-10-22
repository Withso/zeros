import { describe, expect, it, vi } from "vitest";
import { cloudIncoming, cloudOutgoing, type CloudRuntimeScope } from "../cloud-runtime-wire";
import { cloudScopedId, cloudWorkspaceKey } from "../cloud-workspace-key";
import { bridgeChatTitleSeedsByOwner } from "../workspace-bridge";
import type { RuntimeClient } from "../ws-client";

const scope: CloudRuntimeScope = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  root: "/home/user/Owner/repo",
  engineWorkspaceId: "22222222-2222-4222-8222-222222222222",
};
const seed = (chatId: string) => ({ chatId, messageId: "m1", prompt: "Fix the build", answered: true });

describe("cloud chat title seeds", () => {
  it("asks the worker by native chat ID and returns seeds owned by the cloud workspace", () => {
    const out = cloudOutgoing(scope, { type: "WORKSPACE_REQUEST", op: "chats.titleSeeds",
      params: { workspaceId: cloudWorkspaceKey(scope), chatIds: [cloudScopedId(scope, "a"), cloudScopedId(scope, "b")] } });
    expect(out.params).toMatchObject({ workspaceId: scope.engineWorkspaceId, chatIds: ["a", "b"] });
    const reply = cloudIncoming(scope, { type: "WORKSPACE_RESPONSE", op: "chats.titleSeeds", result: { seeds: [seed("a")] } });
    expect(reply.result).toEqual({ seeds: [seed(cloudScopedId(scope, "a"))] });
  });

  it("splits a mixed batch by owner, keeps Local exact and lets a stopped workspace retry later", async () => {
    const other = { ...scope, workspaceId: "33333333-3333-4333-8333-333333333333" };
    const calls: Record<string, unknown>[] = [];
    const request = vi.fn(async (message: { params: Record<string, unknown> }) => {
      calls.push(message.params);
      const owner = message.params.workspaceId;
      if (owner === cloudWorkspaceKey(other)) throw new Error("The cloud workspace is stopped");
      const ids = message.params.chatIds as string[];
      return { type: "WORKSPACE_RESPONSE", op: "chats.titleSeeds", result: { seeds: ids.map(seed) } };
    });
    const bridge = { request } as unknown as RuntimeClient;
    const seeds = await bridgeChatTitleSeedsByOwner(bridge,
      ["local-1", cloudScopedId(scope, "a"), "local-2", cloudScopedId(other, "z")]);
    expect(calls).toEqual([
      { chatIds: ["local-1", "local-2"] },
      { chatIds: [cloudScopedId(scope, "a")], workspaceId: cloudWorkspaceKey(scope) },
      { chatIds: [cloudScopedId(other, "z")], workspaceId: cloudWorkspaceKey(other) },
    ]);
    expect(seeds.map(row => row.chatId)).toEqual(["local-1", "local-2", cloudScopedId(scope, "a")]);
  });
});
