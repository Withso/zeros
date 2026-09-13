import {
  useTerminalStore,
  isRunSessionId,
  isSetupSessionId,
} from "../terminal/terminal-store";
import {
  useWorkspaceStore,
  workbenchScopeForFolder,
} from "../../state/workspace-store";
import { type OpenTerminalIntent } from "./terminal-tabs";
import { useTerminalPanelLayoutStore } from "../terminal/terminal-panel-layout";

export function openWorkbenchTerminal(
  folder: string,
  intent: OpenTerminalIntent,
  scope = workbenchScopeForFolder(folder),
): void {
  const store = useWorkspaceStore.getState();
  store.dispatch({ type: "OPEN_WORKBENCH_TERMINAL", scope, ...intent });
  const tab = useWorkspaceStore
    .getState()
    .workbenchByScope[
      scope
    ]?.tabs.find((t) => t.type === "terminal" && t.terminalId === intent.terminalId);
  if (tab?.terminalPlacement === "panel")
    useTerminalPanelLayoutStore.getState().setExpanded(true);
}

/** This is a plain workspace shell. Conversation terminal agents stay separate. */
export function addWorkbenchTerminal(
  folder: string,
  placement: "tab" | "panel" = "tab",
  scope = workbenchScopeForFolder(folder),
): void {
  const session = useTerminalStore.getState().createSession(folder, null);
  openWorkbenchTerminal(
    folder,
    {
      terminalId: session.id,
      title: session.title,
      placement,
    },
    scope,
  );
}

export function closeWorkbenchTerminal(
  folder: string,
  tabId: string,
  terminalId: string,
  scope = workbenchScopeForFolder(folder),
): void {
  const terminal = useTerminalStore.getState();
  const plain = terminal.sessions.filter(
    (s) =>
      s.folder === folder && !isRunSessionId(s.id) && !isSetupSessionId(s.id),
  );
  if (plain.length > 1 && plain.some((s) => s.id === terminalId))
    terminal.closeSession(terminalId);
  // Setup/Run views and the last shell can close without killing their process;
  // every destination remains discoverable in another terminal's sidebar.
  useWorkspaceStore.getState().dispatch({
    type: "REMOVE_WORKBENCH_TAB",
    scope,
    id: tabId,
  });
}
