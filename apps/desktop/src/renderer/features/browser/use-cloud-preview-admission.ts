import { useEffect, useState } from "react";
import {
  isCloudAgentPreviewTarget,
  type CloudAgentPreviewTarget,
} from "@zeros/protocol/containment";
import {
  openCloudWorkspacePreview,
  revokeCloudWorkspaceAccess,
} from "../../platform/cloud-workspace-access";
import {
  parseCloudScopedId,
  parseCloudWorkspaceKey,
} from "../../platform/bridge/cloud-workspace-key";
import { nativeInvoke } from "../../platform/runtime";
import { getOrganizationStoreGeneration } from "../team/team-store";
import { useInternalFeatureActive } from "../settings/internal-features";
import { toast } from "../../shared/ui/primitives/elements";
import { useAgentSessions } from "../agent/sessions-hooks";
import {
  previewNavigationDescriptor,
  type PreviewNavigationInput,
} from "./preview-navigation";

/** Admission belongs to the retained tab's exact workspace/URL/listener, never
 * the currently selected workspace. Hidden tabs retire the frame's grant and
 * a late response is revoked by its own access id, without touching a successor. */
export function useCloudPreviewAdmission(options: {
  scope: string;
  url: string;
  frameName: string;
  active: boolean;
  ready: boolean;
  source?: {
    chatId: string;
    port: number;
    executionId?: string;
    portId?: string;
  };
  agentPreview: boolean;
  navigate(input: PreviewNavigationInput): void | Promise<void>;
}) {
  const enabled = useInternalFeatureActive("cloudComputerV2");
  const sessions = useAgentSessions();
  const accountGeneration = getOrganizationStoreGeneration();
  const [visible, setVisible] = useState(
    () =>
      typeof document === "undefined" || document.visibilityState !== "hidden",
  );
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  const { scope, url, frameName, active, ready, agentPreview, navigate } =
    options;
  const executionId = options.source?.executionId,
    portId = options.source?.portId;
  const chatId = options.source?.chatId,
    displayPort = options.source?.port;
  useEffect(() => {
    let workspace: ReturnType<typeof parseCloudWorkspaceKey>;
    try {
      workspace = parseCloudWorkspaceKey(scope);
    } catch {
      return;
    }
    if (!workspace || !enabled || !active || !visible || !ready || !url) return;
    const logical = new URL(url);
    const port = Number(
      logical.port || (logical.protocol === "https:" ? 443 : 80),
    );
    if (agentPreview) {
      let scoped: ReturnType<typeof parseCloudScopedId>;
      try {
        scoped = parseCloudScopedId(executionId);
      } catch {
        return;
      }
      if (
        !chatId ||
        (scoped &&
          (scoped.organizationId !== workspace.organizationId ||
            scoped.workspaceId !== workspace.workspaceId))
      )
        return;
    }
    let cancelled = false;
    let errorShown = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const epoch = accountGeneration;
    const admit = async () => {
      try {
        let target: CloudAgentPreviewTarget | undefined;
        if (agentPreview) {
          const owner = sessions.getSession(chatId!);
          const livePort = owner?.boundaryPorts?.ports.find((candidate) =>
            portId ? candidate.id === portId : candidate.port === displayPort,
          );
          if (
            !owner?.executionId ||
            !livePort ||
            (executionId && owner.executionId !== executionId)
          )
            throw new Error("preview listener is no longer active");
          const opened = await sessions.openBoundaryPort(chatId!, livePort.id);
          if (cancelled || epoch !== getOrganizationStoreGeneration()) return;
          if (!opened.nativeTarget) {
            const descriptor = previewNavigationDescriptor(opened);
            if (descriptor.volatileOrigin) {
              const authorization = await nativeInvoke<{ ok: boolean }>(
                "browser:authorize-preview-origin",
                {
                  frameName,
                  origin: descriptor.runtimeOrigin,
                  expiresAt: descriptor.expiresAt,
                },
              );
              if (!authorization.ok)
                throw new Error("preview origin was not authorized");
            }
            if (cancelled || epoch !== getOrganizationStoreGeneration()) return;
            await navigate(opened);
            if (cancelled || epoch !== getOrganizationStoreGeneration()) return;
            errorShown = false;
            timer = setTimeout(
              () => void admit(),
              Math.max(1_000, opened.expiresAt - Date.now() - 5 * 60_000),
            );
            return;
          }
          const scoped = parseCloudScopedId(owner.executionId);
          if (
            !executionId ||
            !portId ||
            !isCloudAgentPreviewTarget(opened.nativeTarget) ||
            opened.nativeTarget.executionId !==
              (scoped?.id ?? owner.executionId) ||
            opened.nativeTarget.portId !== livePort.id
          )
            throw new Error("preview listener identity changed");
          target = opened.nativeTarget;
        }
        const receipt = await openCloudWorkspacePreview({
          ...workspace,
          port,
          frameName,
          ...(target ? { target } : {}),
        });
        if (cancelled || epoch !== getOrganizationStoreGeneration()) {
          await revokeCloudWorkspaceAccess(receipt.accessId).catch(() => false);
          return;
        }
        const navigation = new URL(receipt.origin);
        navigation.pathname = logical.pathname;
        navigation.search = logical.search;
        navigation.hash = logical.hash;
        const expiresAt = Date.parse(receipt.expiresAt);
        await navigate({
          url,
          admissionUrl: navigation.toString(),
          expiresAt,
          native: true,
        });
        if (cancelled || epoch !== getOrganizationStoreGeneration()) return;
        errorShown = false;
        timer = setTimeout(
          () => void admit(),
          Math.max(1_000, expiresAt - Date.now() - 5 * 60_000),
        );
      } catch {
        if (!cancelled && epoch === getOrganizationStoreGeneration()) {
          if (!errorShown) {
            errorShown = true;
            toast.error("Preview connection is unavailable", {
              description:
                "Check that the workspace and its server are running.",
            });
          }
          timer = setTimeout(() => void admit(), 15_000);
        }
      }
    };
    void admit();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      void nativeInvoke("browser:revoke-preview-origin", { frameName }).catch(
        () => undefined,
      );
    };
  }, [
    scope,
    url,
    frameName,
    active,
    visible,
    ready,
    enabled,
    executionId,
    portId,
    chatId,
    displayPort,
    agentPreview,
    navigate,
    sessions,
    accountGeneration,
  ]);
}
