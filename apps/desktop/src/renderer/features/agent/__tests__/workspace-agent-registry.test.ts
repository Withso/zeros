import { beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ request: vi.fn(), grants: vi.fn() }));
vi.mock("../../../platform/bridge/active-bridge", () => ({
  getActiveBridge: () => ({ request: mock.request }),
}));
vi.mock("../../../platform/cloud-workspaces", () => ({
  cloudAgentDelegations: mock.grants,
}));
vi.mock("../../../state/cloud-workspace-catalog", () => ({
  cloudWorkspaceDocument: () => null,
  subscribeCloudWorkspaces: () => () => {},
}));
import {
  clearCloudAgentRegistry,
  warmCloudAgentRegistry,
  workspaceAgentsSnapshot,
} from "../workspace-agent-registry";
const a =
  "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
const b =
  "cloud://11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333";
beforeEach(() => {
  vi.clearAllMocks();
  clearCloudAgentRegistry();
});
describe("workspace agent registry", () => {
  it("does not offer unqualified API-key modes when only account modes were proven", async () => {
    mock.request.mockResolvedValue({ type: "AGENT_AGENTS_LIST", agents: [{ id: "codex", installed: true }, { id: "claude", installed: true }, { id: "cursor", installed: true }] });
    mock.grants.mockResolvedValue([{ kind: "codex-api-key", runtimeQualified: false }, { kind: "claude-api-key", runtimeQualified: false }, { kind: "cursor-api-key", runtimeQualified: true }]);
    expect((await warmCloudAgentRegistry(a)).map(agent => agent.id)).toEqual(["cursor"]);
    clearCloudAgentRegistry();
    mock.grants.mockResolvedValue([{ kind: "codex-chatgpt", runtimeQualified: true }, { kind: "claude-setup-token", runtimeQualified: true }, { kind: "cursor-api-key", runtimeQualified: true }]);
    expect((await warmCloudAgentRegistry(a)).map(agent => agent.authenticated)).toEqual([true, true, true]);
  });
  it("deduplicates exact workspace reads and keeps each workspace's grants separate", async () => {
    mock.request.mockResolvedValue({
      type: "AGENT_AGENTS_LIST",
      agents: [
        { id: "codex", installed: true },
        { id: "claude", installed: true },
      ],
    });
    mock.grants.mockImplementation(async (target) => [
      {
        kind: target.workspaceId.startsWith("2222")
          ? "codex-api-key"
          : "claude-api-key",
      },
    ]);
    await Promise.all([
      warmCloudAgentRegistry(a),
      warmCloudAgentRegistry(a),
      warmCloudAgentRegistry(b),
    ]);
    expect(mock.request).toHaveBeenCalledTimes(2);
    expect(mock.request.mock.calls.map(([request]) => request.cwd)).toEqual([
      a,
      b,
    ]);
    expect(
      workspaceAgentsSnapshot(a)?.map((agent) => agent.authenticated),
    ).toEqual([true, false]);
    expect(
      workspaceAgentsSnapshot(b)?.map((agent) => agent.authenticated),
    ).toEqual([false, true]);
  });
  it("does not publish a late credential snapshot after sign-out", async () => {
    let resolve!: (value: unknown) => void;
    mock.request.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    mock.grants.mockResolvedValue([{ kind: "codex-api-key" }]);
    const pending = warmCloudAgentRegistry(a);
    clearCloudAgentRegistry();
    resolve({
      type: "AGENT_AGENTS_LIST",
      agents: [{ id: "codex", installed: true }],
    });
    await pending;
    expect(workspaceAgentsSnapshot(a)).toBeNull();
  });
});
