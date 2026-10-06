import { useEffect, useRef, useState } from "react";
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
import { useWorkbenchStatusSource } from "../../shell/workbench/tab-status";
import { useAgentSessions } from "../agent/sessions-hooks";
import { useCloudWorkspaceCanEdit } from "../../state/use-cloud-workspace-can-edit";
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
  navigationVersion?: number;
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
  const canEdit = useCloudWorkspaceCanEdit(options.scope);
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
  // Page-originated path changes retain the current grant. Explicit toolbar
  // navigation uses navigationVersion; renewal follows the latest logical URL.
  const currentUrl = useRef(url);
  currentUrl.current = url;
  const logicalOrigin = url ? new URL(url).origin : "";
  const navigationVersion = options.navigationVersion;
  const ownerKey = JSON.stringify([
    scope,
    logicalOrigin,
    navigationVersion,
    options.source,
  ]);
  const [failure, setFailure] = useState<{
    key: string;
    error: unknown;
  } | null>(null);
  const [pending, setPending] = useState(false);
  const retry = useRef<(() => Promise<void>) | null>(null);
  useWorkbenchStatusSource(
    {
      error: failure?.key === ownerKey ? failure.error : null,
      pending,
      primary: true,
      // Admission confirms access, not rendered content. The iframe source
      // alone confirms that the exact preview loaded successfully.
      retry: () => (active ? retry.current?.() : undefined),
    },
    ownerKey,
  );
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
    if (!workspace || !enabled || !canEdit || !active || !visible || !ready || !logicalOrigin) return;
    const logical = new URL(logicalOrigin);
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    const epoch = accountGeneration;
    let flight: Promise<void> | null = null;
    const admit = () => {
      if (flight) return flight;
      clearTimeout(timer);
      setPending(true);
      flight = (async () => {
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
            const opened = await sessions.openBoundaryPort(
              chatId!,
              livePort.id,
            );
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
              if (cancelled || epoch !== getOrganizationStoreGeneration())
                return;
              await navigate(opened);
              if (cancelled || epoch !== getOrganizationStoreGeneration())
                return;
              setFailure(null);
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
            await revokeCloudWorkspaceAccess(receipt.accessId).catch(
              () => false,
            );
            return;
          }
          const url = currentUrl.current;
          const destination = new URL(url);
          const navigation = new URL(receipt.origin);
          navigation.pathname = destination.pathname;
          navigation.search = destination.search;
          navigation.hash = destination.hash;
          const expiresAt = Date.parse(receipt.expiresAt);
          await navigate({
            url,
            admissionUrl: navigation.toString(),
            expiresAt,
            native: true,
          });
          if (cancelled || epoch !== getOrganizationStoreGeneration()) return;
          setFailure(null);
          timer = setTimeout(
            () => void admit(),
            Math.max(1_000, expiresAt - Date.now() - 5 * 60_000),
          );
        } catch (error) {
          if (!cancelled && epoch === getOrganizationStoreGeneration()) {
            setFailure({ key: ownerKey, error });
            timer = setTimeout(() => void admit(), 15_000);
          }
        }
      })().finally(() => {
        flight = null;
        if (!cancelled) setPending(false);
      });
      return flight;
    };
    retry.current = admit;
    void admit();
    return () => {
      cancelled = true;
      if (retry.current === admit) retry.current = null;
      clearTimeout(timer);
      void nativeInvoke("browser:revoke-preview-origin", { frameName }).catch(
        () => undefined,
      );
    };
  }, [
    scope,
    logicalOrigin,
    frameName,
    active,
    visible,
    ready,
    enabled,
    canEdit,
    executionId,
    portId,
    chatId,
    displayPort,
    agentPreview,
    navigate,
    sessions,
    accountGeneration,
    ownerKey,
    navigationVersion,
  ]);
}
