import {
  parseLocalLink,
  type LocalLink,
  type LocalLinkScheme,
} from "@zeros/protocol/local-orchestration";
import type { LocalLinkSnapshot } from "../../../platform/local-link-snapshot";
import { isCloudWorkspace } from "../../../platform/bridge/cloud-workspace-key";
import { isPersonalLocalLinkWorkspace } from "../../../state/local-link-scope";
import { normalizeProjectRoot } from "../../../state/projects-store";
import { folderIsWithinRoot } from "../../../state/workspace-resolution";
import type { ChatThread } from "../../../state/store";
import { workspaceLabel } from "../../../shell/workspace-tabs";

export interface LocalLinkSpan {
  start: number;
  end: number;
  href: string;
  link: LocalLink;
}

/** Unlike extractLocalLinks, presentation keeps every occurrence and its
 * offsets. Consume the complete URL first: a query/path must not become a
 * clickable, truncated chat identity. Sentence punctuation stays outside. */
export function localLinkSpans(
  text: string,
  scheme: LocalLinkScheme,
): LocalLinkSpan[] {
  const spans: LocalLinkSpan[] = [];
  const pattern =
    /\bzeros(?:-alpha|-beta|-dev)?:\/\/(?:chat|workspace)\/[^\s<>"'`()[\]{}]+/g;
  for (const match of text.matchAll(pattern)) {
    if (match.index > 0 && /[\w/:.-]/.test(text[match.index - 1])) continue;
    const href = match[0].replace(/[.,:;!?-]+$/, "");
    const link = parseLocalLink(href);
    if (link?.scheme === scheme)
      spans.push({
        start: match.index,
        end: match.index + href.length,
        href,
        link,
      });
  }
  return spans;
}

export interface LocalLinkLabel {
  label: string;
  agentId?: string | null;
  available: boolean;
  glyphSeed?: string;
}

export interface LocalLinkIndex {
  chats: ReadonlyMap<string, LocalLinkLabel>;
  workspaces: ReadonlyMap<string, LocalLinkLabel>;
  allowsFolder: (folder: string) => boolean;
}

export function localLinkSourceEnabled(input: {
  rollout: boolean;
  organizationId: string | null;
  runtimeKind: string | undefined;
  cwd: string | null | undefined;
  index: LocalLinkIndex | null;
}): boolean {
  return (
    input.rollout &&
    input.organizationId == null &&
    input.runtimeKind === "local" &&
    !!input.cwd &&
    !isCloudWorkspace(input.cwd) &&
    input.index?.allowsFolder(input.cwd) === true
  );
}

type LiveChat = Pick<
  ChatThread,
  "id" | "title" | "agentId" | "folder" | "archived" | "kind"
>;
const indexes = new WeakMap<
  LocalLinkSnapshot,
  WeakMap<readonly LiveChat[], LocalLinkIndex>
>();

/** One index per confirmed catalog + live chat array, shared by retained
 * transcripts. A pill performs only a Map lookup. Folder ownership is resolved
 * once per distinct cwd, with the same most-specific-owner rule as navigation. */
export function localLinkIndex(
  snapshot: LocalLinkSnapshot,
  liveChats: readonly LiveChat[],
): LocalLinkIndex {
  let byChats = indexes.get(snapshot);
  if (!byChats) indexes.set(snapshot, (byChats = new WeakMap()));
  const cached = byChats.get(liveChats);
  if (cached) return cached;
  const owners = [...snapshot.workspaces].sort(
    (a, b) =>
      normalizeProjectRoot(b.path).length - normalizeProjectRoot(a.path).length,
  );
  const projects = [...snapshot.projects].sort(
    (a, b) =>
      normalizeProjectRoot(b.repoRoot).length -
      normalizeProjectRoot(a.repoRoot).length,
  );
  const folders = new Map<
    string,
    { available: boolean; workspaceId: string | null }
  >();
  const resolveFolder = (folder: string) => {
    const key = normalizeProjectRoot(folder);
    const previous = folders.get(key);
    if (previous) return previous;
    const owner = owners.find((row) => folderIsWithinRoot(key, row.path));
    const managed = owner?.id.startsWith("ws_") ? owner : null;
    const project = managed
      ? projects.find(
          (row) =>
            normalizeProjectRoot(row.repoRoot) ===
            normalizeProjectRoot(managed.repoRoot),
        )
      : projects.find((row) => folderIsWithinRoot(key, row.repoRoot));
    const result = {
      available:
        !!project &&
        !isCloudWorkspace(key) &&
        !isCloudWorkspace(project.repoRoot) &&
        (!owner || isPersonalLocalLinkWorkspace(owner)),
      workspaceId: managed?.id ?? (project ? `folder:${project.id}` : null),
    };
    folders.set(key, result);
    return result;
  };
  const chats = new Map<string, LocalLinkLabel>();
  const live = new Map(liveChats.map((chat) => [chat.id, chat]));
  for (const row of snapshot.chats) {
    const updated = live.get(row.id);
    // Never let a stale owner/title survive a moved or archived live row.
    const sameFolder = !updated || updated.folder === row.folder;
    const available =
      sameFolder &&
      !row.archived &&
      !updated?.archived &&
      row.kind !== "terminal" &&
      updated?.kind !== "terminal" &&
      resolveFolder(row.folder).available;
    chats.set(row.id, {
      available,
      label: available ? updated?.title || row.title || "Chat" : "Chat",
      agentId: available ? (updated?.agentId ?? row.agentId) : null,
    });
  }
  // Pristine tabs and originator edits reach the store before the saved
  // catalog. Admit missing rows through the same confirmed folder owner.
  for (const row of liveChats) {
    if (chats.has(row.id)) continue;
    const available =
      !row.archived &&
      row.kind !== "terminal" &&
      resolveFolder(row.folder).available;
    chats.set(row.id, {
      available,
      label: available ? row.title || "Chat" : "Chat",
      agentId: available ? row.agentId : null,
    });
  }
  const workspaces = new Map<string, LocalLinkLabel>();
  for (const row of snapshot.workspaces) {
    if (!row.id.startsWith("ws_")) continue;
    const owner = resolveFolder(row.path);
    const available = owner.available && owner.workspaceId === row.id;
    workspaces.set(row.id, {
      available,
      label: available ? workspaceLabel(row) : "Workspace",
      glyphSeed: `${row.repoSlug}/${row.branch}`,
    });
  }
  for (const project of snapshot.projects) {
    const id = `folder:${project.id}`;
    const owner = resolveFolder(project.repoRoot);
    const available = owner.available && owner.workspaceId === id;
    workspaces.set(id, {
      available,
      label: available ? project.name || "Workspace" : "Workspace",
    });
  }
  const index = {
    chats,
    workspaces,
    allowsFolder: (folder: string) => resolveFolder(folder).available,
  };
  byChats.set(liveChats, index);
  return index;
}
