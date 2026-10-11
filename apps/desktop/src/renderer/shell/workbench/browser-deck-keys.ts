/** Retained Browser deck identity: the exact workbench scope plus tab id, so
 * equal tab ids in different workspaces never share an iframe. */
export function browserViewKey(scope: string, tabId: string): string {
  return JSON.stringify([scope, tabId]);
}

/** Deck keys for the active scope, ordered least to most protected from
 * eviction: every Browser tab of the scope, then tabs floating over the chat
 * (evicting one would reload the page the user is watching), then the active
 * tab. Keys without a mounted Browser tab are skipped. */
export function activeBrowserDeckKeys(input: {
  scopeKeys: Iterable<string>;
  availableKeys: ReadonlySet<string>;
  activeScope: string;
  activeId: string | null;
  floats: readonly { scope: string; tabId: string }[];
}): string[] {
  const keys = [...input.scopeKeys];
  for (const entry of input.floats) {
    const key = browserViewKey(entry.scope, entry.tabId);
    if (input.availableKeys.has(key)) keys.push(key);
  }
  const activeKey = input.activeId
    ? browserViewKey(input.activeScope, input.activeId)
    : null;
  if (activeKey && input.availableKeys.has(activeKey)) keys.push(activeKey);
  return keys;
}
