import { Children, createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Button } from "../../../shared/ui/primitives";
import {
  CloudAgentCredentialsCard,
  type CloudAgentCredentialsCardProps,
} from "../cloud-agent-credentials-card";

const organizationId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const folder = `cloud://${organizationId}/${workspaceId}`;
const fundingOwnerUserId = "33333333-3333-4333-8333-333333333333";
const bootId = "55555555-5555-4555-8555-555555555555";
const writerEpoch = "66666666-6666-4666-8666-666666666666";
const engineInstanceId = "77777777-7777-4777-8777-777777777777";

function workspace(): NonNullable<CloudAgentCredentialsCardProps["restart"]["workspace"]> {
  return {
    id: workspaceId, organizationId, teamId: organizationId, name: "Workspace",
    createdBy: fundingOwnerUserId, ownerUserId: "44444444-4444-4444-8444-444444444444", placement: "cloud",
    agentCredentials: { mode: "boot-owner-v1", fundingScope: "workspace-roles-v1",
      bootId, writerEpoch, fundingOwnerUserId, fundingOwnerEpoch: 1, generation: 7, engineInstanceId,
      status: "owner-changed" },
    actorRole: "owner", status: "ready", capabilities: {
      canWrite: true, canManage: true, canStart: false, startUnavailableReason: null,
    },
    repository: { forge: "github.com", owner: "example", name: "repository", revision: "main" },
    generation: { number: 7, architecture: "x86_64", observedState: "running",
      lastObservedAt: null, resources: { cpuMillicores: 4000, memoryMiB: 8192, storageMiB: 10240 } },
    version: 1, error: null, createdAt: "2026-10-08T00:00:00.000Z",
    updatedAt: "2026-10-08T00:00:00.000Z", deletedAt: null,
  };
}

function props(overrides: Partial<CloudAgentCredentialsCardProps> = {}): CloudAgentCredentialsCardProps {
  return {
    folder, active: true,
    binding: { organizationId, workspaceId, mode: "boot-owner-v1", fundingScope: "workspace-roles-v1",
      bootId, writerEpoch, fundingOwnerUserId, fundingOwnerEpoch: 1, generation: 7, engineInstanceId },
    restart: { visible: true, enabled: true, workspace: workspace(), request: vi.fn() },
    ...overrides,
  };
}

function render(input = props()): string {
  return renderToStaticMarkup(createElement(CloudAgentCredentialsCard, input));
}

function restartButton(node: ReactNode): { disabled?: boolean; onClick?: () => void } | undefined {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<{ children?: ReactNode; disabled?: boolean; onClick?: () => void }>(child)) continue;
    if (child.type === Button) return child.props;
    const found = restartButton(child.props.children);
    if (found) return found;
  }
  return undefined;
}

describe("cloud agent credential change card", () => {
  it("shows the exact notice and delegates Restart to the existing action", () => {
    const input = props();
    const html = render(input);
    expect(html).toContain("Agent credentials changed");
    expect(html).toContain("Restart workspace");
    expect(html).toContain('role="status"');
    expect(input.restart.request).not.toHaveBeenCalled();
    const button = restartButton(CloudAgentCredentialsCard(input));
    expect(button?.disabled).toBe(false);
    button?.onClick?.();
    expect(input.restart.request).toHaveBeenCalledExactlyOnceWith();
  });

  it.each(["legacy", "current"] as const)("hides %s owner status without starting work", status => {
    const input = props();
    if (status === "legacy") delete input.restart.workspace!.agentCredentials;
    else input.restart.workspace!.agentCredentials!.status = "current";
    expect(render(input)).toBe("");
    expect(input.restart.request).not.toHaveBeenCalled();
  });

  it("does not show Restart for an account/key change or token rotation", () => {
    const input = props();
    input.restart.workspace!.agentCredentials!.status = "current";
    input.restart.workspace!.ownerUserId = fundingOwnerUserId;
    expect(render(input)).toBe("");
    expect(input.restart.request).not.toHaveBeenCalled();
  });

  it("requires the real negotiated current binding", () => {
    const input = props({ binding: undefined });
    expect(render(input)).toBe("");
    expect(input.restart.request).not.toHaveBeenCalled();
  });

  it.each(["bootId", "writerEpoch", "fundingOwnerUserId", "fundingOwnerEpoch", "engineInstanceId", "generation"] as const)(
    "rejects late %s state from another boot or generation", field => {
      const input = props();
      if (field === "generation" || field === "fundingOwnerEpoch") input.restart.workspace!.agentCredentials![field] += 1;
      else input.restart.workspace!.agentCredentials![field] = "88888888-8888-4888-8888-888888888888";
      expect(render(input)).toBe("");
      expect(input.restart.request).not.toHaveBeenCalled();
    });

  it.each(["organizationId", "workspaceId"] as const)("rejects a negotiated binding from another %s", field => {
    const input = props();
    input.binding = { ...input.binding!, [field]: "88888888-8888-4888-8888-888888888888" };
    expect(render(input)).toBe("");
    expect(input.restart.request).not.toHaveBeenCalled();
  });

  it("rejects a workspace document whose generation differs from its credential boot", () => {
    const input = props(); input.restart.workspace!.generation.number += 1;
    expect(render(input)).toBe("");
  });

  it.each([undefined, "/local/personal", "/local/organization"])("adds no card or action to Local (%s)", localFolder => {
    const input = props({ folder: localFolder });
    expect(render(input)).toBe("");
    expect(input.restart.request).not.toHaveBeenCalled();
  });

  it.each(["workspace", "organization", "missing"])("rejects %s metadata from another card owner", mismatch => {
    const input = props();
    const doc = input.restart.workspace!;
    if (mismatch === "workspace") doc.id = "44444444-4444-4444-8444-444444444444";
    if (mismatch === "organization") doc.organizationId = "55555555-5555-4555-8555-555555555555";
    if (mismatch === "missing") input.restart.workspace = undefined;
    expect(render(input)).toBe("");
    expect(input.restart.request).not.toHaveBeenCalled();
  });

  it.each(["archiving", "archived", "deleting", "deleted"])("does not offer credential Restart for %s", status => {
    const input = props(); input.restart.workspace!.status = status;
    expect(render(input)).toBe("");
  });

  it.each(["viewer", "prompter", "developer"] as const)("keeps %s information readable with a disabled action", role => {
    const input = props(); const doc = input.restart.workspace!;
    doc.actorRole = role; doc.capabilities.canManage = false;
    doc.capabilities.canWrite = role !== "viewer";
    const html = render(input);
    expect(html).toContain("Agent credentials changed");
    expect(html).toContain('disabled=""');
    expect(html).toContain("Workspace management access is required to restart.");
    restartButton(CloudAgentCredentialsCard(input))?.onClick?.();
    expect(input.restart.request).not.toHaveBeenCalled();
  });

  it.each(["manager", "owner"] as const)("obeys the server capability for %s", role => {
    const input = props(); input.restart.workspace!.actorRole = role;
    const allowed = restartButton(CloudAgentCredentialsCard(input));
    expect(allowed?.disabled).toBe(false);
    allowed?.onClick?.();
    expect(input.restart.request).toHaveBeenCalledOnce();
    input.restart.workspace!.capabilities.canManage = false;
    const refused = restartButton(CloudAgentCredentialsCard(input));
    expect(refused?.disabled).toBe(true);
    refused?.onClick?.();
    expect(input.restart.request).toHaveBeenCalledOnce();
  });

  it("keeps the existing run/access refusal and does not bypass it for a manager", () => {
    const input = props(); input.restart.workspace!.capabilities.canWrite = false;
    input.restart.disabledReason = "Workspace run access is required to restart.";
    expect(render(input)).toContain(input.restart.disabledReason);
    restartButton(CloudAgentCredentialsCard(input))?.onClick?.();
    expect(input.restart.request).not.toHaveBeenCalled();
    input.restart.visible = false;
    expect(render(input)).toBe("");
  });

  it("retains the notice while restarting and cannot launch a second action", () => {
    const input = props(); input.restart.disabledReason = "This workspace is restarting.";
    expect(render(input)).toContain("Agent credentials changed");
    expect(render(input)).toContain(input.restart.disabledReason);
    restartButton(CloudAgentCredentialsCard(input))?.onClick?.();
    expect(input.restart.request).not.toHaveBeenCalled();
  });

  it("keeps a retained hidden card inert without announcing or restarting", () => {
    const input = props({ active: false });
    expect(render(input)).toContain("Agent credentials changed");
    expect(render(input)).toContain('aria-live="off"');
    restartButton(CloudAgentCredentialsCard(input))?.onClick?.();
    expect(input.restart.request).not.toHaveBeenCalled();
  });

  it("uses the existing running-work confirmation dialog and clears only from state", () => {
    const input = props(); input.restart.dialog = createElement("div", { "data-running-work-confirmation": true });
    expect(render(input)).toContain("data-running-work-confirmation");
    restartButton(CloudAgentCredentialsCard(input))?.onClick?.();
    expect(render(input)).toContain("Agent credentials changed");
    input.restart.workspace!.agentCredentials!.status = "current";
    expect(render(input)).toBe("");
  });

  it.each(["canManage", "canWrite", "inactive", "restarting"] as const)(
    "closes an already-open confirmation when %s action authority is lost", refusal => {
      const input = props();
      input.restart.dialog = createElement("div", { "data-running-work-confirmation": true });
      expect(render(input)).toContain("data-running-work-confirmation");
      if (refusal === "canManage") input.restart.workspace!.capabilities.canManage = false;
      if (refusal === "canWrite") input.restart.workspace!.capabilities.canWrite = false;
      if (refusal === "inactive") input.active = false;
      if (refusal === "restarting") input.restart.disabledReason = "This workspace is restarting.";
      const html = render(input);
      expect(html).toContain("Agent credentials changed");
      expect(html).not.toContain("data-running-work-confirmation");
      restartButton(CloudAgentCredentialsCard(input))?.onClick?.();
      expect(input.restart.request).not.toHaveBeenCalled();
    });
});
