import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CloudWorkspaceDocumentSchema } from "../../../platform/cloud-workspaces";
import { cloudWorkspaceKey } from "../../../platform/bridge/cloud-workspace-key";
import { CloudHistoryRecoveryNoticeView } from "../cloud-history-recovery-notice";

const organizationId = "11111111-1111-4111-8111-111111111111", workspaceId = "22222222-2222-4222-8222-222222222222";
const binding = { generation: 1, engineInstanceId: "66666666-6666-4666-8666-666666666666", bootId: "44444444-4444-4444-8444-444444444444",
  writerEpoch: "55555555-5555-4555-8555-555555555555" };
const workspace = CloudWorkspaceDocumentSchema.parse({ id: workspaceId, organizationId, teamId: organizationId, createdBy: organizationId,
  name: "History fixture", placement: "cloud", status: "ready", version: 1, error: null, deletedAt: null,
  createdAt: "2026-10-14T00:00:00Z", updatedAt: "2026-10-14T00:00:00Z", capabilities: { canWrite: true, canManage: false, canStart: false, startUnavailableReason: null },
  repository: { forge: "github.com", owner: "example", name: "fixture", revision: "main" },
  generation: { number: 1, architecture: "linux/amd64", resources: { cpuMillicores: 2000, memoryMiB: 4096, storageMiB: 20480 }, observedState: "running", lastObservedAt: null },
  agentCredentials: { ...binding, mode: "boot-owner-v1", fundingScope: "workspace-roles-v1", status: "current", fundingOwnerUserId: organizationId, fundingOwnerEpoch: 1 },
  historyRecovery: { ...binding, recoveryId: "88888888-8888-4888-8888-888888888888", code: "history_recovered_with_gap", coverage: "unknown", completedAt: "2026-10-14T00:00:00Z" },
});
const props = { folder: cloudWorkspaceKey({ organizationId, workspaceId }), active: true, connected: true, workspace, dismissed: false, onDismiss: () => {} };
const render = (value: Parameters<typeof CloudHistoryRecoveryNoticeView>[0]) => renderToStaticMarkup(createElement(CloudHistoryRecoveryNoticeView, value));
describe("authorized history-gap warning", () => {
  it("shows the exact approved title/body with a nonblocking, dismissible status once usable", () => {
    const html = render(props);
    expect(html).toContain("Recent history may be incomplete");
    expect(html).toContain("The workspace recovered after an interrupted stop. Check recent messages and work before retrying a request.");
    expect(html).toContain('role="status"'); expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-label="Dismiss history recovery warning"');
    expect(html).not.toContain('role="dialog"'); expect(html).not.toContain('aria-modal'); expect(html).not.toContain("Retry");
  });
  it("never shows on Local Personal, organization-local, hidden, disconnected or dismissed surfaces", () => {
    for (const patch of [{ folder: "/personal/repo" }, { folder: "/organization/repo" }, { active: false }, { connected: false }, { dismissed: true }])
      expect(render({ ...props, ...patch })).toBe("");
  });
  it("rejects foreign owner keys and unavailable or unbound successors, retaining a receipt across later ready generations", () => {
    for (const patch of [{ organizationId: workspaceId }, { id: organizationId }, { status: "setting_up" }, { status: "stopped" },
      { deletedAt: "2026-10-14T00:00:00Z" }, { agentCredentials: undefined }, { historyRecovery: undefined },
      { agentCredentials: { ...workspace.agentCredentials!, status: "owner-changed" as const } },
      { historyRecovery: { ...workspace.historyRecovery!, generation: 2 } }])
      expect(render({ ...props, workspace: { ...workspace, ...patch } })).toBe("");
    expect(render({ ...props, workspace: { ...workspace, generation: { ...workspace.generation, number: 2 },
      agentCredentials: { ...workspace.agentCredentials!, generation: 2 } } })).toContain("Recent history may be incomplete");
  });
});
