import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentAdapter } from "../types";
import type { CloudAgentExecutionFactory } from "../cloud-provider-execution";
import { AgentGateway } from "../gateway";
import { loadCloudWorkerConfiguration } from "../containment/cloud-worker-config";
import { copyCloudNativeForkHistory } from "../containment/cloud-native-history";
import { testCloudWorker } from "./helpers/test-cloud-runtime";
import { testExecutionBoundary } from "./helpers/test-execution-boundary";
import { closeZerosDb } from "../../db";
import { getWorkspaceById, insertWorkspace } from "../../git/state";

vi.mock("../containment/cloud-worker-config", () => ({ loadCloudWorkerConfiguration: vi.fn() }));
vi.mock("../containment/cloud-native-history", async original => ({
  ...await original<typeof import("../containment/cloud-native-history")>(),
  copyCloudNativeForkHistory: vi.fn(async () => ({ version: 1, kind: "native", providerId: "codex", resumeId: "forked" })),
}));
let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "zeros-cloud-fork-floor-")));
  vi.stubEnv("ZEROS_DATA_DIR", path.join(root, "data"));
  vi.stubEnv("ZEROS_USER_SETTINGS_DIR", path.join(root, "settings"));
  vi.mocked(loadCloudWorkerConfiguration).mockReset();
  vi.mocked(copyCloudNativeForkHistory).mockClear();
});
afterEach(() => { closeZerosDb(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
function fixture(options: { cloud?: boolean; organizationId?: string | null } = {}) {
  const cloud = options.cloud !== false;
  const workspaceId = cloud ? undefined : "local-fork-workspace";
  if (workspaceId) {
    insertWorkspace({
      id: workspaceId, organizationId: options.organizationId ?? null, placement: "local",
      repoSlug: "fixture/repository", repoRoot: root, branch: "main", baseBranch: "main",
      path: root, status: "in-progress", createdAt: Date.now(), archivedAt: null,
      stashRef: null, prNumber: null, prState: null, prUrl: null, agentId: null, lastActiveAt: null,
    });
  }
  const prepare = vi.fn();
  const gateway = new AgentGateway({ projectRoot: root,
    executionBoundary: cloud ? { ...testExecutionBoundary(), backend: "cloud-worker" } : testExecutionBoundary(),
    cloudAgentExecutionFactory: { prepare } as CloudAgentExecutionFactory,
    events: { onSessionUpdate() {}, onPermissionRequest() {}, onQuestionRequest() {}, onAgentStderr() {}, onAgentExit() {} },
  });
  const providerBinding = { version: 1 as const, kind: "native" as const, providerId: "codex", resumeId: "local-fork", scopeId: "original-lineage" };
  const forkProviderBinding = vi.fn(async () => ({ providerBinding }));
  const adapter = { agentId: "codex", forkProviderBinding, dispose: async () => {} } as unknown as AgentAdapter;
  const internal = gateway as unknown as { adapters: Map<string, AgentAdapter>; executionToAgent: Map<string, string>; prepareCodeAgentTerritory: () => Promise<undefined>; resolveSessionMcp: () => Promise<[]> };
  internal.adapters.set("codex", adapter);
  internal.prepareCodeAgentTerritory = async () => undefined;
  internal.resolveSessionMcp = async () => [];
  const fork = () => gateway.forkProviderBinding("codex", { version: 1, kind: "native", providerId: "codex", resumeId: "source" }, {
    cwd: root, workspaceId, sourceConversationId: "source-conversation", conversationId: "destination-conversation",
    ...(cloud ? { cloudExecution: { delegationId: "11111111-1111-4111-8111-111111111111", model: "model",
      source: { kind: "session" as const, actorSessionId: "22222222-2222-4222-8222-222222222222" } } } : {}),
  });
  return { fork, prepare, forkProviderBinding, providerBinding, executionToAgent: internal.executionToAgent, workspaceId };
}
it("routes an admitted native fork through the v4 worker history scope", async () => {
  vi.mocked(loadCloudWorkerConfiguration).mockReturnValue(testCloudWorker());
  const { fork, prepare } = fixture();
  await expect(fork()).resolves.toMatchObject({ resumeId: "forked" });
  expect(copyCloudNativeForkHistory).toHaveBeenCalledOnce();
  expect(prepare).not.toHaveBeenCalled();
});
it.each([1, 2, 3])("rejects retired worker %s before copying history or admitting credentials", async version => {
  vi.mocked(loadCloudWorkerConfiguration).mockReturnValue({ ...testCloudWorker(), version } as unknown as ReturnType<typeof loadCloudWorkerConfiguration>);
  const { fork, prepare, forkProviderBinding } = fixture();
  await expect(fork().then(() => undefined)).rejects.toThrow(/qualified worker/);
  expect(copyCloudNativeForkHistory).not.toHaveBeenCalled();
  expect(prepare).not.toHaveBeenCalled(); expect(forkProviderBinding).not.toHaveBeenCalled();
});
it.each([
  { owner: "Personal", organizationId: null },
  { owner: "organization", organizationId: "33333333-3333-4333-8333-333333333333" },
])("preserves $owner Local native forks without cloud authority or credential access", async ({ organizationId }) => {
  vi.mocked(loadCloudWorkerConfiguration).mockImplementation(() => { throw new Error("Local fork read cloud authority"); });
  const { fork, prepare, forkProviderBinding, providerBinding, executionToAgent, workspaceId } = fixture({ cloud: false, organizationId });
  expect(getWorkspaceById(workspaceId!)?.organizationId).toBe(organizationId);
  expect(getWorkspaceById(workspaceId!)?.placement).toBe("local");

  await expect(fork()).resolves.toEqual(providerBinding);

  expect(forkProviderBinding).toHaveBeenCalledOnce();
  expect(loadCloudWorkerConfiguration).not.toHaveBeenCalled();
  expect(copyCloudNativeForkHistory).not.toHaveBeenCalled();
  expect(prepare).not.toHaveBeenCalled();
  expect(executionToAgent.size).toBe(0);
});
