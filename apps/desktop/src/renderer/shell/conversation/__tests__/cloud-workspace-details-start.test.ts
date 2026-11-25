import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { cloudV2Document, type CloudV2Workspace } from "../../../platform/cloud-v2";
import { CloudWorkspaceDetailsCard, cloudStartOperation } from "../cloud-workspace-details";

const failed = (errorCode: string, extra: Record<string, unknown> = {}) => cloudV2Document({
  id: "22222222-2222-4222-8222-222222222222", organizationId: "11111111-1111-4111-8111-111111111111",
  creatorUserId: "33333333-3333-4333-8333-333333333333", name: "w", repository: "Withso/zeros",
  branch: "zeros/w", baseBranch: "main", state: "failed", errorCode, archivedAt: null,
  createdAt: "2026-10-22T00:00:00Z", updatedAt: "2026-10-22T00:00:00Z", version: 2,
  capabilities: { design: false, browser: false, simulators: false, terminal: true, files: true, git: true, agents: ["codex"] },
  ...extra,
} as CloudV2Workspace);

const card = (workspace: ReturnType<typeof cloudV2Document>) => renderToStaticMarkup(createElement(CloudWorkspaceDetailsCard,
  { workspace, statusLabel: "Failed", resources: null, changing: false, onChange: vi.fn() }));

describe("a failed cloud workspace's details", () => {
  // 2026-11-25: a wake that timed out with its VM and backup intact showed no Start, only Delete.
  it("offers Start for a workspace the server marks recoverable, and Start recovers it", () => {
    const recoverable = failed("worker_boot_timeout", { recoverable: true });
    expect(card(recoverable)).toContain("Start workspace");
    expect(cloudStartOperation(recoverable)).toBe("recover");
    // A restore failure the desktop already retries, and a stopped workspace, still wake.
    expect(cloudStartOperation(failed("checkpoint_restore_failed"))).toBe("wake");
    expect(cloudStartOperation({ ...recoverable, status: "stopped" })).toBe("wake");
  });

  it("offers no Start for a failure the server does not mark, such as a create that never ran", () => {
    expect(card(failed("worker_boot_timeout"))).not.toContain("Start workspace");
    expect(card(failed("sandbox_missing"))).not.toContain("Start workspace");
  });
});
