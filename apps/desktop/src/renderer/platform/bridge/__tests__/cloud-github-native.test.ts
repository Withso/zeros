import { expect, it, vi } from "vitest";
import { createMessage, type BridgeMessage } from "@zeros/protocol/messages";
import { installCloudGithubNative } from "../cloud-github-native";
import type { RuntimeClient } from "../ws-client";
const org = "11111111-1111-4111-8111-111111111111", workspace = "22222222-2222-4222-8222-222222222222";
const engine = "33333333-3333-4333-8333-333333333333", requestId = "44444444-4444-4444-8444-444444444444";
function fixture() {
  let listener!: (message: BridgeMessage) => void;
  const request = vi.fn(async () => ({ type: "WORKSPACE_RESPONSE" }));
  const client = { on: (_type: string, fn: typeof listener) => { listener = fn; return () => {}; },
    onStatusChange: () => () => {}, request } as unknown as RuntimeClient;
  const input = { actorUserId: org, organizationId: org, workspaceId: workspace, generation: 1,
    engineInstanceId: engine, owner: "org", repository: "repo", repositoryId: "42", operation: "git.push" as const,
    paramsSha256: "a".repeat(64), native: { requestId, generation: 1, engineInstanceId: engine,
      source: { kind: "terminal" as const, actorSessionId: org }, branch: "topic" } };
  return { client, request, input, receive: (value = input) => listener(createMessage({ type: "GITHUB_NATIVE_GRANT_REQUEST", source: "engine", request: value })) };
}
it("uses the integrated desktop prepare route and returns only a scoped grant", async () => {
  const f = fixture(), grant = `zgw_${"a".repeat(43)}`, prepare = vi.fn(async () => ({ grant }));
  const stop = installCloudGithubNative(f.client, { organizationId: org, workspaceId: workspace, generation: 1 }, prepare);
  f.receive();
  await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(2));
  expect(prepare).toHaveBeenCalledWith({ action: "prepareWrite", organizationId: org, workspaceId: workspace,
    operation: "git.push", paramsSha256: "a".repeat(64), native: f.input.native });
  expect(f.request).toHaveBeenLastCalledWith({ type: "WORKSPACE_REQUEST", op: "github.nativeGrant", params: { kind: "reply", requestId, grant } });
  stop(); f.receive(); expect(prepare).toHaveBeenCalledTimes(1);
});
it("ignores another workspace/generation and does not relay credential errors", async () => {
  const f = fixture(), prepare = vi.fn(async () => { throw new Error("synthetic-private-user-token"); });
  const stop = installCloudGithubNative(f.client, { organizationId: org, workspaceId: workspace, generation: 1 }, prepare);
  f.receive({ ...f.input, generation: 2 }); f.receive({ ...f.input, workspaceId: org });
  expect(prepare).not.toHaveBeenCalled();
  f.receive(); await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(2));
  expect(f.request).toHaveBeenLastCalledWith({ type: "WORKSPACE_REQUEST", op: "github.nativeGrant", params: { kind: "reply", requestId, grant: null } });
  expect(JSON.stringify(f.request.mock.calls)).not.toContain("synthetic-private-user-token"); stop();
});
