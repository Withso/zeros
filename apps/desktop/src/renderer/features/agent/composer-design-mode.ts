import { isCloudWorkspace } from "../../platform/bridge/cloud-workspace-key";

export function composerDesignModeAvailable(input: {
  chatId: string | null | undefined;
  bridge: unknown;
  workspaceId: string | null | undefined;
}): boolean {
  return Boolean(input.chatId && input.bridge && !isCloudWorkspace(input.workspaceId));
}

export function shouldFocusComposerForDesignActivation(
  activeElement: Element | null,
  composerRoot: Element | null,
): boolean {
  return !composerRoot?.contains(activeElement);
}

export function activateComposerDesignMode(input: {
  activeElement: Element | null;
  composerEditor: Element | null;
  focusComposer: () => void;
  enterDesignMode: () => void;
}): void {
  if (shouldFocusComposerForDesignActivation(input.activeElement, input.composerEditor)) input.focusComposer();
  input.enterDesignMode();
}
