import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { ZerosEngine } from "../zeros-engine";
import { initializeDesignDocument } from "../design/document";
import { testExecutionBoundary } from "../agents/__tests__/helpers/test-execution-boundary";
import type { AgentSessionToolRegistry } from "../agents/session-tools";
import type { WorkspaceService } from "../workspace/service";
import type { Workspace } from "../git";

// The preview broker is independent of Design admission and would require
// a deployed preview-link file simply to construct a transport-only fixture.
vi.mock(
  "../agents/containment/cloud-preview-links",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../agents/containment/cloud-preview-links")
    >()),
    CloudPreviewGatewayFactory: class {},
  }),
);

it("does not grant cloud Design authority merely because a cloud transport is configured", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zeros-design-tool-host-"));
  vi.stubEnv("ZEROS_CLOUD_PORT", "29981");
  vi.stubEnv("ZEROS_CLOUD_TOKEN", "t".repeat(32));
  const engine = new ZerosEngine({
    root,
    executionBoundary: testExecutionBoundary(),
  });
  const state = engine as unknown as {
    workspace: WorkspaceService;
    agents: {
      sessionTools: AgentSessionToolRegistry;
      dispose(): Promise<void>;
    };
  };
  const workspace = {
    id: "cloud-workspace",
    path: root,
    repoRoot: root,
    placement: "cloud",
    archivedAt: null,
  } as Workspace;
  vi.spyOn(state.workspace, "designAgentWorkspace").mockReturnValue(workspace);
  vi.spyOn(state.workspace, "workspaceIdForCwd").mockReturnValue(workspace.id);
  try {
    await initializeDesignDocument(root);
    const env = {};
    const servers = await state.agents.sessionTools.admit(
      {
        executionId: "code-run",
        conversationId: "chat",
        workspaceId: workspace.id,
        cwd: root,
      },
      [],
      env,
    );
    expect(servers).toEqual([]);
    expect(env).toEqual({});
  } finally {
    await state.agents.dispose();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
