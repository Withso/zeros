import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeClient } from "../ws-client";
import { WorkspaceRuntimeClient, type CloudPeer, type WorkspaceRuntimeOptions } from "../workspace-runtime-client";
import type { CloudWorkspaceTarget } from "../cloud-workspace-key";

const organizationId = "11111111-1111-4111-8111-111111111111";
const cloud = { organizationId, workspaceId: "22222222-2222-4222-8222-222222222222" };

afterEach(() => vi.restoreAllMocks());

/** Evaluate the production BridgeProvider routing object from use-bridge.tsx
 * with stubbed catalog accessors, so these controls cover its real wiring. */
function providerRouting(open: WorkspaceRuntimeOptions["open"]) {
  const source = ts.createSourceFile("use-bridge.tsx", readFileSync(new URL("../use-bridge.tsx", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression: ts.NewExpression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isNewExpression(node) && node.expression.getText(source) === "WorkspaceRuntimeClient") expression = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!expression) throw new Error("Bridge routing factory missing");
  const document = vi.fn(() => ({ status: "ready", deletedAt: null, generation: { number: 7 }, capabilities: { canWrite: true },
    repository: { owner: "Owner", name: "repo" } }));
  const context: Record<string, unknown> = {
    WorkspaceRuntimeClient: class { constructor(options: WorkspaceRuntimeOptions) { context.routing = options; } },
    openCloudV2Runtime: open, getCloudWorkspaceRows: () => [], cloudWorkspaceCatalogConfirmed: () => false,
    canReadCloudWorkspace: (doc: unknown) => !!doc, cloudWorkspaceDocument: document, cloudCatalogGeneration: () => 1,
    cloudWorkspaceStopVersion: () => 0, isCloudWorkspaceLifecyclePending: () => false, cloudWorkspaceOperation: vi.fn(),
    readCloudV2History: vi.fn(async () => ({ chats: [], chatDeletions: [] })),
    cloudV2CheckoutPath: (doc: { repository: { owner: string; name: string } }) => `/home/user/${doc.repository.owner}/${doc.repository.name}`,
  };
  vm.runInNewContext(ts.transpileModule(expression.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return { routing: context.routing as WorkspaceRuntimeOptions, document };
}

function fakePeer(target: CloudWorkspaceTarget) {
  const request = vi.fn(async (message: Record<string, unknown>) => ({ type: "WORKSPACE_RESPONSE", op: message.op,
    result: message.op === "chats.list" ? { chats: [], chatDeletions: [] } : { workspaces: [] } }));
  const client = { request, send: vi.fn(), status: "connected", on: () => () => {}, onStatusChange: () => () => {} } as unknown as RuntimeClient;
  const peer: CloudPeer = { client, scope: { ...target, root: "/home/user/Owner/repo", engineWorkspaceId: target.workspaceId },
    runtimeId: target.workspaceId, generation: 7, release: vi.fn() };
  return { peer, request };
}

describe("BridgeProvider Local Git routing", () => {
  it.each([null, organizationId])(
    "keeps local-placement Git on the sidecar for owner %s while a cloud peer is open",
    async (owner) => {
      const peer = fakePeer(cloud);
      const open = vi.fn(async () => peer.peer);
      const row = { id: "ws_local", path: "/local/repository/worktree", placement: "local", organizationId: owner };
      const factory = providerRouting(open);
      const client = new WorkspaceRuntimeClient({ ...factory.routing, workspaces: () => [row] });
      try {
        await client.warmWorkspace(cloud);
        // Let the peer's own background chat read settle; only the Local Git
        // requests below are under test.
        await vi.waitFor(() => expect(peer.request).toHaveBeenCalled());
        await new Promise((resolve) => setTimeout(resolve, 0));
        open.mockClear();
        peer.request.mockClear();
        factory.document.mockClear();
        const response = { type: "WORKSPACE_RESPONSE", result: { ok: true } };
        const local = vi.spyOn(RuntimeClient.prototype, "request").mockResolvedValue(response as never);
        for (const op of ["git.fetch", "git.pull", "git.push"]) {
          const message = {
            type: "WORKSPACE_REQUEST" as const,
            op,
            params: { workspaceId: row.id, remote: "origin", strategy: "rebase", autoStash: true },
          };
          expect(await client.request(message)).toBe(response);
          expect(local).toHaveBeenLastCalledWith(message, expect.anything());
        }
        expect(local).toHaveBeenCalledTimes(3);
        expect(open).not.toHaveBeenCalled();
        expect(peer.request).not.toHaveBeenCalled();
        expect(factory.document).not.toHaveBeenCalled();
      } finally {
        client.dispose();
      }
    },
  );
});
