export interface CopyPathKey {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  defaultPrevented: boolean;
}

/** ⌘C copies the worktree path, but only when it cannot be a real copy: no
 * text selection, focus not on a typing surface, and no other listener that
 * uses the key. Listeners on window run in registration order, so a surface
 * that owns ⌘C for its own selection (the Design canvas copies the selected
 * layer) may not have seen the event yet: decide once every listener has. */
export function handleCopyPathKey(
  event: CopyPathKey,
  env: { active: boolean; editable: boolean; textSelected: boolean; defer(work: () => void): void; copy(): void },
): void {
  if (!env.active || event.defaultPrevented) return;
  if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.code !== "KeyC") return;
  if (env.editable || env.textSelected) return;
  env.defer(() => {
    if (!event.defaultPrevented) env.copy();
  });
}
