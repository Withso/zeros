import { cloudWorkspaceKey, parseCloudWorkspaceKey } from "../../platform/bridge/cloud-workspace-key";
import { agentSessionHasActiveWork, useSessionsStore, type SessionsStoreState } from "../../features/agent/sessions-store";
import { useWorkspaceStore } from "../../state/workspace-store";
import { getRunActivitySnapshot } from "../terminal/run-activity-store";
import { peekTerminalTabIndicators } from "../terminal/terminal-tab-indicators";
import { useTerminalStore, type TerminalSession } from "../terminal/terminal-store";
import { isLoopbackHost } from "../workbench/tabs/localhost-url";
import type { WorkbenchTab } from "../workbench/tab-model";

interface RunningWorkSnapshot {
  chats: readonly { id: string; folder: string }[];
  sessions: SessionsStoreState["sessions"];
  pendingTurns: SessionsStoreState["pendingLocalTurns"];
  terminals: readonly Pick<TerminalSession, "folder" | "alive">[];
  tabs: readonly WorkbenchTab[];
  scriptsRunning: boolean;
}

/** Inspect confirmed renderer observations at click time; never wake, poll or
 * request runtime data just to decide whether a confirmation is needed. */
export function cloudWorkspaceHasRunningWork(folder: string, snapshot?: RunningWorkSnapshot): boolean {
  const target = parseCloudWorkspaceKey(folder);
  if (!target) return false;
  const owner = cloudWorkspaceKey(target);
  const owns = (path: string | null) => {
    const candidate = parseCloudWorkspaceKey(path ?? "");
    return candidate !== null && cloudWorkspaceKey(candidate) === owner;
  };
  if (!snapshot) {
    const workspace = useWorkspaceStore.getState();
    const agents = useSessionsStore.getState();
    snapshot = {
      chats: workspace.chats, sessions: agents.sessions, pendingTurns: agents.pendingLocalTurns,
      terminals: useTerminalStore.getState().sessions,
      tabs: Object.entries(workspace.workbenchByScope).filter(([scope]) => owns(scope)).flatMap(([, scope]) => scope.tabs),
      scriptsRunning: getRunActivitySnapshot(owner) || Object.values(peekTerminalTabIndicators(owner))
        .some(indicator => indicator.running || indicator.dot === "running"),
    };
  }
  const chatIds = new Set(snapshot.chats.filter(chat => owns(chat.folder)).map(chat => chat.id));
  if (Object.keys(snapshot.pendingTurns).some(id => chatIds.has(id))) return true;
  if (Object.entries(snapshot.sessions).some(([id, session]) =>
    (chatIds.has(id) || owns(session.cwd)) &&
      (agentSessionHasActiveWork(session, snapshot!.pendingTurns[id]) ||
        session.messages.some(message => message.kind === "text" && (message.queued || message.queuedDelivery)) ||
        (session.boundaryPorts?.ports.length ?? 0) > 0),
  )) return true;
  if (snapshot.scriptsRunning) return true;
  // The renderer has no authoritative foreground-process field for plain
  // shells. Conservatively confirm for live terminals, including silent work.
  if (snapshot.terminals.some(terminal => terminal.alive && owns(terminal.folder))) return true;
  return snapshot.tabs.some(tab => {
    if (tab.type !== "browser") return false;
    if (tab.previewSource) return true;
    try { return !!tab.url && isLoopbackHost(new URL(tab.url).hostname); }
    catch { return false; }
  });
}
