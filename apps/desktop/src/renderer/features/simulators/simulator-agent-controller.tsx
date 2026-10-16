import { useEffect, useRef } from "react";

import { isCloudWorkspace } from "../../platform/bridge/cloud-workspace-key";
import { defaultScopeFor } from "../../shell/workbench/tab-model";
import { useWorkspaceStore } from "../../state/store";
import { workbenchScopeForFolder } from "../../state/workspace-store";
import {
  followSimulatorAgents,
  simulatorAgentState,
  subscribeSimulatorAgentState,
} from "./simulator-agent-store";
import {
  routeSimulatorAgent,
  simulatorAgentKey,
  type SimulatorAgentTabProgress,
} from "./simulator-tab-model";

/** Opens the Simulator tab of each device an agent starts using, in its
 * chat's workspace: on screen when that chat is, else in the background
 * until the user goes to it. */
export function SimulatorAgentController({
  onRevealWorkbench,
}: {
  onRevealWorkbench: () => void;
}) {
  const revealRef = useRef(onRevealWorkbench);
  revealRef.current = onRevealWorkbench;

  useEffect(() => {
    const progress = new Map<string, SimulatorAgentTabProgress>();
    const route = () => {
      const holders = simulatorAgentState()?.holders ?? [];
      const using = new Set<string>();
      let reveal = false;
      for (const holder of holders) {
        const key = simulatorAgentKey(holder);
        using.add(key);
        const workspace = useWorkspaceStore.getState();
        const chat = workspace.chats.find((entry) => entry.id === holder.conversationId);
        // Chats load after main can already report a holder; retried when they do.
        if (!chat) continue;
        if (isCloudWorkspace(chat.folder)) {
          progress.set(key, "shown");
          continue;
        }
        const scope = workbenchScopeForFolder(chat.folder || null);
        const next = routeSimulatorAgent({
          device: holder,
          progress: progress.get(key),
          onScreen: workspace.activeChatId === chat.id && workspace.activePage === "workspace",
          scope,
          tabs: (workspace.workbenchByScope[scope] ?? defaultScopeFor(scope)).tabs,
        });
        if (!next) continue;
        // Store subscribers run during dispatch, so remember first.
        progress.set(key, next.progress);
        for (const action of next.actions) useWorkspaceStore.getState().dispatch(action);
        if (next.revealWorkbench) reveal = true;
      }
      for (const key of [...progress.keys()]) {
        if (!using.has(key)) progress.delete(key);
      }
      if (reveal) revealRef.current();
    };
    const unsubscribeAgents = subscribeSimulatorAgentState(route);
    const unsubscribeWorkspace = useWorkspaceStore.subscribe((state, previous) => {
      if (
        state.chats === previous.chats &&
        state.activeChatId === previous.activeChatId &&
        state.activePage === previous.activePage
      ) {
        return;
      }
      route();
    });
    const stopFollowing = followSimulatorAgents();
    return () => {
      unsubscribeAgents();
      unsubscribeWorkspace();
      stopFollowing();
    };
  }, []);

  return null;
}
