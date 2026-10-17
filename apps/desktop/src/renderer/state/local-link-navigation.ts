import type { LocalLink } from "@zeros/protocol/local-orchestration";
import type { ChatRowWire } from "../features/agent/agent-history-client";
import type { Workspace } from "../platform/git";
import type { LocalLinkSnapshot } from "../platform/local-link-snapshot";
import { isCloudWorkspace } from "../platform/bridge/cloud-workspace-key";
import { buildLocalMainWorkspace } from "./local-main-workspace";
import { isPersonalLocalLinkWorkspace } from "./local-link-scope";
import { normalizeProjectRoot, type Project } from "./projects-store";
import { folderIsWithinRoot } from "./workspace-resolution";

export type LocalLinkDestination =
  | {
      ok: true;
      workspace: Workspace;
      folder: string;
      chat: ChatRowWire | null;
    }
  | { ok: false; reason: "not-found" | "local-only" };

const missing = { ok: false, reason: "not-found" } as const;
const foreign = { ok: false, reason: "local-only" } as const;
const sameRoot = (a: string, b: string) =>
  normalizeProjectRoot(a) === normalizeProjectRoot(b);

/** Resolve against fresh native metadata and the user's registered projects.
 * No root adoption, archive restore, provider admission or create is involved. */
export function resolveLocalLinkDestination(
  link: LocalLink,
  snapshot: LocalLinkSnapshot,
  registeredProjects: readonly Project[],
  preferredChatId?: string | null,
): LocalLinkDestination {
  const resolveFolder = (folder: string): LocalLinkDestination => {
    if (isCloudWorkspace(folder)) return foreign;
    const owner = snapshot.workspaces
      .filter((row) => folderIsWithinRoot(folder, row.path))
      .sort(
        (a, b) =>
          normalizeProjectRoot(b.path).length -
          normalizeProjectRoot(a.path).length,
      )[0];
    if (
      owner &&
      (owner.organizationId != null ||
        owner.placement === "cloud" ||
        isCloudWorkspace(owner.repoRoot))
    )
      return foreign;
    if (owner && !isPersonalLocalLinkWorkspace(owner)) return missing;
    const managed = owner?.id.startsWith("ws_") ? owner : null;
    const project = managed
      ? snapshot.projects.find((row) =>
          sameRoot(row.repoRoot, managed.repoRoot),
        )
      : snapshot.projects
          .filter(
            (row) =>
              !isCloudWorkspace(row.repoRoot) &&
              folderIsWithinRoot(folder, row.repoRoot),
          )
          .sort((a, b) => b.repoRoot.length - a.repoRoot.length)[0];
    if (!project) return missing;
    const registered = registeredProjects.find((row) =>
      sameRoot(row.repoRoot, project.repoRoot),
    );
    if (!registered || isCloudWorkspace(registered.repoRoot)) return missing;
    return {
      ok: true,
      workspace: managed ?? buildLocalMainWorkspace(registered),
      folder,
      chat: null,
    };
  };

  if (link.kind === "chat") {
    const chat = snapshot.chats.find((row) => row.id === link.id);
    if (!chat || chat.archived || chat.kind === "terminal") return missing;
    const destination = resolveFolder(chat.folder);
    return destination.ok ? { ...destination, chat } : destination;
  }

  let destination: LocalLinkDestination;
  if (link.id.startsWith("folder:")) {
    const project = snapshot.projects.find(
      (row) => row.id === link.id.slice("folder:".length),
    );
    if (!project) return missing;
    destination = resolveFolder(project.repoRoot);
    // A folder alias must not bypass a managed owner's permissions or identity.
    if (destination.ok && destination.workspace.id.startsWith("ws_"))
      return missing;
  } else {
    const workspace = snapshot.workspaces.find(
      (row) => row.id === link.id && row.id.startsWith("ws_"),
    );
    if (!workspace) return missing;
    destination = resolveFolder(workspace.path);
    if (destination.ok && destination.workspace.id !== workspace.id)
      return missing;
  }
  if (!destination.ok) return destination;
  const workspace = destination.workspace;
  const chats = snapshot.chats.filter((chat) => {
    if (
      chat.archived ||
      chat.kind === "terminal" ||
      !folderIsWithinRoot(chat.folder, workspace.path)
    )
      return false;
    const own = resolveFolder(chat.folder);
    return own.ok && own.workspace.id === workspace.id;
  });
  const chat =
    chats.find((row) => row.id === preferredChatId) ??
    chats.sort((a, b) => b.updatedAt - a.updatedAt)[0] ??
    null;
  return { ...destination, chat, folder: chat?.folder ?? workspace.path };
}
