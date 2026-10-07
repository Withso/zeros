import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CloudWorkspaceDocument } from "../../platform/cloud-workspaces";
import { TooltipProvider } from "../../shared/ui/primitives";
import { CloudWorkspaceDetailsContent } from "../conversation/cloud-workspace-details";

const workspace: CloudWorkspaceDocument = {
  id: "22222222-2222-4222-8222-222222222222", organizationId: "11111111-1111-4111-8111-111111111111",
  teamId: "11111111-1111-4111-8111-111111111111", name: "Cloud feature", createdBy: "33333333-3333-4333-8333-333333333333",
  placement: "cloud", status: "ready", version: 1, error: null, deletedAt: null,
  createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z",
  capabilities: { canWrite: true, canManage: true, canStart: true, canEdit: true, startUnavailableReason: null },
  repository: { forge: "github.com", owner: "example", name: "repo", revision: "main" },
  generation: { number: 2, architecture: "linux/amd64", observedState: "running", lastObservedAt: null,
    resources: { cpuMillicores: 2000, memoryMiB: 4096, storageMiB: 20480 } },
};
const usage = { organizationId: workspace.organizationId, workspaceId: workspace.id, generation: 2,
  cpu: { cores: 2, usedPercent: 12.5 }, memory: { totalBytes: 4_000_000_000, usedPercent: 25 }, disk: { totalBytes: 20_000_000_000, usedPercent: 42 } };
function render(props: Partial<Parameters<typeof CloudWorkspaceDetailsContent>[0]> = {}) {
  return renderToStaticMarkup(createElement(TooltipProvider, { children: createElement(CloudWorkspaceDetailsContent,
    { workspace, creator: "Arun", now: Date.parse("2026-10-03T00:00:00Z"), ...props }) }));
}
describe("compact cloud workspace details", () => {
  it("keeps metadata, a rename control and safe repository navigation in the condensed layout", () => {
    const html = render();
    expect(html).toContain("Cloud feature");
    expect(html).toContain('aria-label="Rename workspace"');
    expect(html).toContain("Arun · 2d ago");
    expect(html).toContain('aria-label="Open repository"');
    expect(html).toContain("Setup succeeded");
    expect(html).toContain("Running");
    expect(html).not.toContain("Runtime ·");
    expect(html).not.toContain("Workspace port");
    expect(html).not.toContain("Manage sharing");
  });
  it("shows unavailable usage without making up zeroes", () => {
    const html = render();
    expect(html.match(/—/g)).toHaveLength(3);
    expect(html).not.toContain("0% used");
  });
  it("shows actual resource denominators with live percentages", () => {
    const html = render({ resourceUsage: usage });
    expect(html).toContain("2 cores");
    expect(html).toContain("12.5% used");
    expect(html).toContain("4 GB");
    expect(html).toContain("25% used");
    expect(html).toContain("20 GB");
    expect(html).toContain("42% used");
  });
  it.each(["ready", "busy"])("shows usage for healthy %s documents with the normal acknowledgement policy", status => {
    const html = render({ workspace: { ...workspace, status, recovery: { state: null, checkpointId: null,
      checkpointAt: null, sourceGeneration: 2, needsAcknowledgement: true } }, resourceUsage: usage });
    expect(html).toContain("12.5% used");
    expect(html).toContain("25% used");
    expect(html).toContain("42% used");
  });
  it("suppresses usage during active recovery even without a data-loss acknowledgement", () => {
    const html = render({ workspace: { ...workspace, recovery: { state: "recovery_needed", checkpointId: null,
      checkpointAt: null, sourceGeneration: 2, needsAcknowledgement: false } }, resourceUsage: usage });
    expect(html).not.toContain("12.5% used");
    expect(html).toContain("Recovery needs attention");
  });
  it.each(["stopped", "failed", "archived"])("does not display a running sample for %s", status => {
    const html = render({ workspace: { ...workspace, status }, resourceUsage: usage });
    expect(html).not.toContain("12.5% used");
  });
  it("rejects a sample from a different workspace or generation", () => {
    expect(render({ resourceUsage: { ...usage, generation: 1 } })).not.toContain("12.5% used");
    expect(render({ resourceUsage: { ...usage, workspaceId: "44444444-4444-4444-8444-444444444444" } })).not.toContain("12.5% used");
  });
  it("keeps retired metadata and capacity while suppressing usage and showing the fixed refusal", () => {
    const html = render({ workspace: { ...workspace, capabilities: { ...workspace.capabilities,
      canStart: false, startUnavailableReason: "cloud_workspace_v2_required" } }, resourceUsage: usage });
    expect(html).toContain("Cloud feature");
    expect(html).toContain("2 cores");
    expect(html).toContain("This workspace uses a retired cloud runtime — create a new workspace.");
    expect(html).not.toContain("12.5% used");
  });
  it("keeps archived Status visible and retains capacity", () => {
    const html = render({ workspace: { ...workspace, status: "archived" } });
    expect(html).toContain("Archived");
    expect(html).toContain("2 cores");
  });
  it("keeps creation age relative beyond a month", () => {
    expect(render({ workspace: { ...workspace, createdAt: "2026-08-19T00:00:00Z" } })).toContain("Arun · 45d ago");
  });
  it("does not invent navigation for an unsupported forge", () => {
    expect(render({ workspace: { ...workspace, repository: { ...workspace.repository, forge: "foreign.test" } } })).not.toContain('aria-label="Open repository"');
  });
});
