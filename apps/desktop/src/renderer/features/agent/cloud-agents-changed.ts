import { cloudWorkspaceKey, parseCloudWorkspaceKey } from "../../platform/bridge/cloud-workspace-key";

/** A cloud worker's `DB_CHANGED { kinds: ["agents"] }`: its agents or their model lists changed (a login revision, or
 * the activated Creator's logins and models). The workspace's agent list is re-read and every open chat in it re-reads
 * its model list, without reopening and without a timer. */
export function watchCloudAgentsChanged(
  bridge: { on(type: "DB_CHANGED", handler: (message: unknown) => void): () => void },
  options: {
    sessions(): Record<string, { cwd?: string | null } | undefined>;
    invalidate(folder: string): void;
    refresh(chatId: string): void;
  },
): () => void {
  return bridge.on("DB_CHANGED", raw => {
    const message = raw as { kinds?: unknown; workspaceIds?: unknown };
    if (!Array.isArray(message.kinds) || !message.kinds.includes("agents") || !Array.isArray(message.workspaceIds)) return;
    for (const id of message.workspaceIds) {
      const target = typeof id === "string" ? parseCloudWorkspaceKey(id) : null;
      if (!target) continue;
      const folder = cloudWorkspaceKey(target);
      options.invalidate(folder);
      for (const [chatId, session] of Object.entries(options.sessions())) {
        const owner = session?.cwd ? parseCloudWorkspaceKey(session.cwd) : null;
        if (owner && cloudWorkspaceKey(owner) === folder) options.refresh(chatId);
      }
    }
  });
}
