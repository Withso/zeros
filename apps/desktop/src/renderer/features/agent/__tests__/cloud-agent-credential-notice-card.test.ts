import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CloudWorkspaceDocument } from "../../../platform/cloud-workspaces";
import { applyCloudAgentCredentialUse, cloudAgentCredentialNoticeState, type CloudAgentCredentialNoticeContext,
  type CloudAgentCredentialUse } from "../cloud-agent-credential-notice";
import { CloudAgentCredentialNoticeCard } from "../cloud-agent-credential-notice-card";

const ids = Array.from({ length: 10 }, (_, i) => `${String(i + 1).padStart(8,"0")}-1111-4111-8111-111111111111`);
function fixture() {
  const binding = { organizationId: ids[0], workspaceId: ids[1], generation: 2, engineInstanceId: ids[2], bootId: ids[3],
    writerEpoch: ids[4], fundingOwnerUserId: ids[5], fundingOwnerEpoch: 1, mode: "boot-owner-v1" as const, fundingScope: "workspace-roles-v1" as const };
  const context: CloudAgentCredentialNoticeContext = { binding, conversationId: "chat", initialAdoptions: [
    { provider: "claude", status: "unknown" }, { provider: "codex", status: "unknown" }, { provider: "cursor", status: "missing" },
  ] };
  const scope = { organizationId: ids[0], workspaceId: ids[1], generation: 2, engineInstanceId: ids[2], bootId: ids[3], writerEpoch: ids[4], fundingOwnerUserId: ids[5], fundingOwnerEpoch: 1 };
  const use: CloudAgentCredentialUse = { version: 1, scope, conversationId: "chat", commandId: ids[6], turnId: "turn", executionId: "execution", eventSequence: 1, firstUseSequence: 1, nativeStage: "native_write",
    credentialRun: { version: 1, bootId: ids[3], writerEpoch: ids[4], fundingOwnerUserId: ids[5], fundingOwnerEpoch: 1,
      provider: "cursor", credentialId: ids[7], credentialRevision: 1, connectionRevision: 1, cacheRevision: 1, materialVersion: 1,
      adoptionId: ids[8], displayName: "Account <reference>" } };
  const workspace: CloudWorkspaceDocument = {
    id: ids[1], organizationId: ids[0], teamId: ids[0], name: "Workspace", createdBy: ids[5], ownerUserId: ids[5], placement: "cloud",
    actorRole: "owner", status: "ready", capabilities: { canWrite: true, canManage: true, canStart: false, startUnavailableReason: null },
    agentCredentials: { mode: binding.mode, fundingScope: binding.fundingScope, generation: binding.generation,
      engineInstanceId: binding.engineInstanceId, bootId: binding.bootId, writerEpoch: binding.writerEpoch,
      fundingOwnerUserId: binding.fundingOwnerUserId, fundingOwnerEpoch: binding.fundingOwnerEpoch, status: "current" },
    repository: { forge: "github.com", owner: "example", name: "repository", revision: "main" },
    generation: { number: 2, architecture: "x86_64", observedState: "running", lastObservedAt: null,
      resources: { cpuMillicores: 4000, memoryMiB: 8192, storageMiB: 10240 } }, version: 1, error: null,
    createdAt: "2026-10-08T00:00:00.000Z", updatedAt: "2026-10-08T00:00:00.000Z", deletedAt: null,
  };
  return { folder: `cloud://${ids[0]}/${ids[1]}`, active: true, context, workspace,
    state: applyCloudAgentCredentialUse(cloudAgentCredentialNoticeState(context), context, use) };
}
type Props = Parameters<typeof CloudAgentCredentialNoticeCard>[0];
const render = (props: Props) => renderToStaticMarkup(createElement(CloudAgentCredentialNoticeCard, props));

describe("actual next-run cloud account information", () => {
  it("renders the actual selected display name safely with the existing notice pattern", () => {
    const html = render(fixture());
    expect(html).toContain("Using Account &lt;reference&gt; for Cursor.");
    expect(html).toContain('role="status"'); expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain("Restart"); expect(html).not.toContain("<button");
  });

  it.each([undefined, "/local/personal", "/local/organization"])("is inert in Local %s", folder => {
    expect(render({ ...fixture(), folder })).toBe("");
  });
  it.each(["context", "state", "workspace"] as const)("waits for confirmed %s rather than using pending/cache intent", field => {
    expect(render({ ...fixture(), [field]: undefined })).toBe("");
  });
  it("hides legacy metadata and an unchanged initial actual-use baseline", () => {
    const f = fixture(); delete f.workspace.agentCredentials;
    expect(render(f)).toBe("");
    const current = fixture(); current.state = cloudAgentCredentialNoticeState(current.context);
    expect(render(current)).toBe("");
  });
  it.each(["organizationId", "workspaceId", "generation", "engineInstanceId", "bootId", "writerEpoch", "fundingOwnerUserId", "fundingOwnerEpoch"] as const)(
    "ignores a late %s from another notice binding", field => {
      const f = fixture();
      f.context = { ...f.context, binding: { ...f.context.binding,
        [field]: field === "generation" || field === "fundingOwnerEpoch" ? 3 : ids[9] } };
      expect(render(f)).toBe("");
    });
  it("keeps information readable for a Viewer without adding execution authority", () => {
    const f = fixture(); f.workspace.actorRole = "viewer"; f.workspace.capabilities.canWrite = false; f.workspace.capabilities.canManage = false;
    expect(render(f)).toContain("Using Account"); expect(render(f)).not.toContain("<button");
  });
  it.each(["archiving", "archived", "deleted"])("hides unavailable %s data", status => {
    const f = fixture(); f.workspace.status = status;
    expect(render(f)).toBe("");
  });
  it("keeps a retained inactive notice inert", () => {
    const html = render({ ...fixture(), active: false });
    expect(html).toContain('aria-live="off"'); expect(html).not.toContain("<button");
  });
});
