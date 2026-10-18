import { useEffect, useState } from "react";
import type { LocalLink } from "@zeros/protocol/local-orchestration";
import { agentControlUnavailableReason } from "@zeros/protocol/agent-control-rollout";
import type { ChatRowWire } from "../features/agent/agent-history-client";
import {
  isAgentControlFeatureActive,
  useAgentControlFeatureActive,
} from "../features/settings/agent-control-rollout";
import {
  setActiveOrganizationSelection,
  subscribeActiveTeam,
} from "../features/team/active-team";
import { PERSONAL_ORGANIZATION_ID } from "../features/team/personal-organization";
import {
  getActiveOrganizationIdSnapshot,
  getOrganizationStoreGeneration,
  useTeams,
} from "../features/team/team-store";
import { CONTROL_PLANE_URL } from "../features/team/control-plane";
import { getActiveBridge } from "../platform/bridge/active-bridge";
import { useBridge, useBridgeStatus } from "../platform/bridge/use-bridge";
import type { RuntimeClient } from "../platform/bridge/ws-client";
import { readLocalLinkSnapshot } from "../platform/local-link-snapshot";
import { onLocalNavigation } from "../platform/local-links";
import { isLocalDevelopment } from "../platform/runtime";
import { toast } from "../shared/ui/primitives/elements";
import { resolveLocalLinkDestination } from "../state/local-link-navigation";
import {
  beginLocalWorkspaceRead,
  notifyProjectsChanged,
  peekProjects,
} from "../state/use-projects";
import { syncProjectsToEngine } from "../state/projects-store";
import { useWorkspaceStore, type ChatThread } from "../state/store";

type ReadChat = (row: ChatRowWire) => ChatThread;

export function observeLocalLinkNavigation(
  bridge: RuntimeClient | null,
  retired: () => void,
) {
  let cancelled = false;
  const generation = getOrganizationStoreGeneration();
  const cancel = () => {
    cancelled = true;
    retired();
  };
  const stopOwner = subscribeActiveTeam(cancel);
  const stopNavigation = useWorkspaceStore.subscribe((next, previous) => {
    if (next.navigationVersion !== previous.navigationVersion) cancel();
  });
  const stopConnection =
    bridge?.status === "connected"
      ? bridge.onStatusChange(() => {
          if (bridge.status !== "connected") cancel();
        })
      : () => {};
  const stop = () => {
    stopOwner();
    stopNavigation();
    stopConnection();
  };
  return {
    current: () =>
      !cancelled &&
      getActiveBridge() === bridge &&
      getOrganizationStoreGeneration() === generation &&
      bridge?.status === "connected",
    stop,
    dispose: () => {
      cancelled = true;
      stop();
    },
  };
}

export async function navigateLocalLink(
  link: LocalLink,
  options: {
    bridge: RuntimeClient;
    readChat: ReadChat;
    current: () => boolean;
    beforeCommit: () => void;
  },
): Promise<void> {
  const { bridge, current } = options;
  try {
    if (bridge.executionIdentity.kind !== "local") {
      if (current()) toast.info("This link opens a Local chat or workspace.");
      return;
    }
    // Reuse boot recovery when this renderer has no registry cache. An
    // explicit empty registry remains empty; links cannot register a path.
    if (peekProjects().length === 0 && (await syncProjectsToEngine()))
      notifyProjectsChanged();
    if (!current()) return;
    for (let attempt = 0; attempt < 2; attempt++) {
      const publishWorkspaces = beginLocalWorkspaceRead();
      const snapshot = await readLocalLinkSnapshot(bridge);
      if (
        !current() ||
        bridge.executionIdentity.kind !== "local" ||
        !isAgentControlFeatureActive("localOrchestration")
      )
        return;
      const state = useWorkspaceStore.getState();
      const destination = resolveLocalLinkDestination(
        link,
        snapshot,
        peekProjects(),
        state.activeChatId,
      );
      if (!destination.ok) {
        toast.info(
          destination.reason === "local-only"
            ? "This link opens a Local chat or workspace."
            : "That chat or workspace couldn't be found.",
        );
        return;
      }
      const existing =
        destination.chat &&
        state.chats.find((chat) => chat.id === destination.chat!.id);
      if (
        existing?.archived ||
        (existing && existing.folder !== destination.chat!.folder)
      ) {
        toast.info("That chat or workspace couldn't be found.");
        return;
      }
      // A live cache refresh or mutation can finish during the catalog read.
      // Retry once instead of publishing over its newer ownership snapshot.
      if (!publishWorkspaces(destination.workspace, snapshot.workspaces)) continue;
      if (!current()) return;
      const chat = destination.chat ? options.readChat(destination.chat) : null;
      options.beforeCommit();
      // Same semantic owner switch as the organization picker. No raw storage
      // writes, engine re-root, archive restoration, or default-tab creation.
      setActiveOrganizationSelection(PERSONAL_ORGANIZATION_ID, true);
      if (getActiveOrganizationIdSnapshot() != null) {
        toast.info("Select Local to open this link.");
        return;
      }
      useWorkspaceStore.getState().dispatch({
        type: "OPEN_LOCAL_LINK",
        workspace: destination.workspace,
        folder: destination.folder,
        chat,
      });
      return;
    }
    throw new Error("Workspace metadata changed during navigation.");
  } catch {
    if (current())
      toast.error("Couldn't open that Local link. Try again in a moment.");
  }
}

/** Main retains an intent until this listener mounts; the bridge and staff
 * gate may then finish booting independently. A newer link or user selection
 * retires the old read, including A → B → A owner switches. */
export function LocalLinkNavigation({ readChat }: { readChat: ReadChat }) {
  const [pending, setPending] = useState<{
    link: LocalLink;
    navigationVersion: number;
  } | null>(null);
  const bridge = useBridge();
  const status = useBridgeStatus();
  const enabled = useAgentControlFeatureActive("localOrchestration");
  const teams = useTeams();
  const accessPending =
    !isLocalDevelopment() &&
    !!CONTROL_PLANE_URL &&
    !teams.me &&
    (teams.status === "idle" || teams.status === "loading");

  useEffect(() => {
    let mounted = true;
    let stop: (() => void) | undefined;
    void onLocalNavigation((link) => {
      if (mounted)
        setPending({
          link,
          navigationVersion:
            useWorkspaceStore.getState().navigationVersion ?? 0,
        });
    })
      .then((off) => {
        if (mounted) stop = off;
        else off();
      })
      .catch(() => {
        if (mounted)
          toast.error(
            "Couldn't listen for Local links. Reopen the window to try again.",
          );
      });
    return () => {
      mounted = false;
      stop?.();
    };
  }, []);

  useEffect(() => {
    if (!pending) return;
    const clear = () =>
      setPending((value) => (value === pending ? null : value));
    if (
      pending.navigationVersion !==
      (useWorkspaceStore.getState().navigationVersion ?? 0)
    ) {
      clear();
      return;
    }
    if (accessPending) return;
    const observation = observeLocalLinkNavigation(bridge, clear);
    if (!enabled) {
      toast.info(agentControlUnavailableReason("localOrchestration"));
      clear();
      return observation.dispose;
    }
    if (!bridge || status !== "connected") return observation.dispose;
    void navigateLocalLink(pending.link, {
      bridge,
      readChat,
      current: observation.current,
      beforeCommit: observation.stop,
    }).finally(() => {
      observation.stop();
      if (observation.current()) clear();
    });
    return observation.dispose;
  }, [pending, enabled, bridge, status, accessPending, readChat]);
  return null;
}
