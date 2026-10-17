import type { ChatRowWire } from "../features/agent/agent-history-client";
import type { Project } from "../state/projects-store";
import type { Workspace } from "./git";
import type { RuntimeClient } from "./bridge/ws-client";
import { WorkspaceRuntimeClient } from "./bridge/workspace-runtime-client";

export interface LocalLinkSnapshot {
  projects: Project[];
  workspaces: Workspace[];
  chats: ChatRowWire[];
}

export async function readLocalLinkSnapshot(
  bridge: RuntimeClient,
): Promise<LocalLinkSnapshot> {
  if (bridge.executionIdentity.kind !== "local")
    throw new Error("Local engine required.");
  const read = async (
    op: "project.list" | "workspace.list" | "chats.list",
    key: keyof LocalLinkSnapshot,
  ) => {
    const response = await (bridge instanceof WorkspaceRuntimeClient
      ? bridge.requestLocalMetadata(op)
      : bridge.request(
          { type: "WORKSPACE_REQUEST", op } as Parameters<
            RuntimeClient["request"]
          >[0],
          10_000,
        ));
    if (response.type !== "WORKSPACE_RESPONSE")
      throw new Error("Couldn't read the Local catalog.");
    const rows = (response as unknown as { result?: Record<string, unknown> })
      .result?.[key];
    if (!Array.isArray(rows))
      throw new Error("Couldn't read the Local catalog.");
    return rows;
  };
  const [projects, workspaces, chats] = await Promise.all([
    read("project.list", "projects"),
    read("workspace.list", "workspaces"),
    read("chats.list", "chats"),
  ]);
  return { projects, workspaces, chats } as LocalLinkSnapshot;
}
