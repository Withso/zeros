import { defaultFilter } from "cmdk";
import type { Workspace } from "../platform/git";
import { isCloudWorkspace } from "../platform/bridge/cloud-workspace-key";
import type { OrganizationSummary } from "../features/team/control-plane";
import { filterRowsForOrganization } from "../features/team/organization-capabilities";
import { PERSONAL_ORGANIZATION } from "../features/team/personal-organization";
import {
  isSettingsSectionAvailable,
  type SettingsSectionAvailability,
} from "../features/settings/settings-section-availability";
import type { Project } from "../state/projects-store";
import type { ChatThread } from "../state/store";
import { folderIsWithinRoot } from "../state/workspace-resolution";
import { workspaceIsReadOnly } from "../state/workspace-history";
import { workspaceLabel } from "./workspace-tabs";
import { searchWorkspaceFiles } from "./workbench/quick-open";

export const PALETTE_CATEGORIES = [
  {
    id: "all",
    label: "All",
    placeholder: "Search workspaces, chats, files, and actions…",
  },
  { id: "workspaces", label: "Workspaces", placeholder: "Search workspaces…" },
  { id: "chats", label: "Chats", placeholder: "Search chats…" },
  {
    id: "files",
    label: "Files",
    placeholder: "Search files in this workspace…",
  },
  { id: "actions", label: "Actions", placeholder: "Search actions…" },
  { id: "settings", label: "Settings", placeholder: "Search settings…" },
] as const;
export type PaletteCategory = (typeof PALETTE_CATEGORIES)[number]["id"];
export type PaletteWorkspaceFilter = "active" | "archived" | "all";
export type PaletteIcon =
  | "workspace"
  | "cloud"
  | "chat"
  | "file"
  | "home"
  | "plus"
  | "folder"
  | "settings"
  | "keyboard"
  | "feedback"
  | "sidebar"
  | "workbench"
  | "terminal"
  | "browser"
  | "changes"
  | "review"
  | "copy"
  | "customize"
  | "sun"
  | "moon"
  | "system";

export interface PaletteCapabilities {
  createWorkspace: boolean;
  localOwner: boolean;
  localNative: boolean;
  workspace: boolean;
  codeWorkspace: boolean;
  terminalAgent: boolean;
  browser: boolean;
  review: boolean;
  activeFile: boolean;
  revealFolder: boolean;
  feedback: boolean;
}

export function paletteCapabilities(input: {
  workspace: Workspace | null;
  folder: string | null;
  onWorkspacePage: boolean;
  loading: boolean;
  localOwner: boolean;
  native: boolean;
  cloudStatus?: string;
  cloudCanEdit: boolean;
  createWorkspace: boolean;
  terminalAgents: boolean;
  activeFile: boolean;
  feedback: boolean;
}): PaletteCapabilities {
  const cloud = isCloudWorkspace(input.folder ?? undefined);
  const workspace =
    input.onWorkspacePage &&
    !!input.workspace &&
    !!input.folder &&
    !input.loading &&
    !workspaceIsReadOnly(input.workspace) &&
    (!cloud ||
      (input.cloudCanEdit &&
        ["ready", "busy"].includes(input.cloudStatus ?? "")));
  const codeWorkspace = workspace && input.workspace?.kind !== "design";
  return {
    createWorkspace: input.createWorkspace,
    localOwner: input.localOwner,
    localNative: input.localOwner && input.native,
    workspace,
    codeWorkspace,
    terminalAgent: codeWorkspace && input.terminalAgents,
    browser: workspace && !cloud,
    review: workspace && !!input.workspace?.prNumber,
    activeFile: workspace && input.activeFile,
    revealFolder: workspace && !cloud && input.native,
    feedback: input.feedback,
  };
}

const ACTIONS = [
  {
    id: "home",
    label: "Go to Dashboard",
    group: "Navigation",
    icon: "home",
    keywords: ["home"],
  },
  {
    id: "create-workspace",
    label: "Create workspace…",
    group: "Navigation",
    icon: "plus",
    when: "createWorkspace",
    keywords: ["new", "project", "agent"],
  },
  {
    id: "settings",
    label: "Open Settings",
    group: "Navigation",
    icon: "settings",
    shortcut: "⌘,",
  },
  {
    id: "customize",
    label: "Open Customize",
    group: "Navigation",
    icon: "customize",
    when: "localOwner",
    keywords: ["mcp", "skills", "extensions"],
  },
  {
    id: "shortcuts",
    label: "Keyboard shortcuts",
    group: "Navigation",
    icon: "keyboard",
    shortcut: "⌥⌘/",
  },
  {
    id: "feedback",
    label: "Send feedback",
    group: "Navigation",
    icon: "feedback",
    shortcut: "⌥⌘F",
    when: "feedback",
  },
  {
    id: "open-folder",
    label: "Open folder…",
    group: "Projects",
    icon: "folder",
    shortcut: "⇧⌘O",
    when: "localNative",
  },
  {
    id: "clone-repository",
    label: "Open GitHub project…",
    group: "Projects",
    icon: "folder",
    when: "localNative",
    keywords: ["clone", "repository"],
  },
  {
    id: "quick-start",
    label: "Create project…",
    group: "Projects",
    icon: "plus",
    when: "localNative",
    keywords: ["quick start", "scratch"],
  },
  {
    id: "new-chat",
    label: "New chat",
    group: "Workspace actions",
    icon: "chat",
    shortcut: "⌘T",
    when: "codeWorkspace",
  },
  {
    id: "new-terminal-agent",
    label: "New terminal agent",
    group: "Workspace actions",
    icon: "terminal",
    shortcut: "⇧⌘T",
    when: "terminalAgent",
  },
  {
    id: "files",
    label: "Browse files",
    group: "Workspace actions",
    icon: "file",
    when: "workspace",
  },
  {
    id: "changes",
    label: "Show changes",
    group: "Workspace actions",
    icon: "changes",
    when: "workspace",
  },
  {
    id: "review",
    label: "Review pull request",
    group: "Workspace actions",
    icon: "review",
    when: "review",
  },
  {
    id: "new-terminal",
    label: "New terminal",
    group: "Workspace actions",
    icon: "terminal",
    when: "workspace",
  },
  {
    id: "browser",
    label: "Open browser",
    group: "Workspace actions",
    icon: "browser",
    shortcut: "⇧⌘B",
    when: "browser",
  },
  {
    id: "copy-file-path",
    label: "Copy relative path of active file",
    group: "Workspace actions",
    icon: "copy",
    when: "activeFile",
  },
  {
    id: "reveal-folder",
    label: "Reveal workspace in Finder",
    group: "Workspace actions",
    icon: "folder",
    when: "revealFolder",
  },
  {
    id: "toggle-sidebar",
    label: "Toggle sidebar",
    group: "View",
    icon: "sidebar",
  },
  {
    id: "toggle-workbench",
    label: "Toggle workbench",
    group: "View",
    icon: "workbench",
    shortcut: "⌥⌘B",
    when: "workspace",
  },
] as const satisfies readonly {
  id: string;
  label: string;
  group: string;
  icon: PaletteIcon;
  shortcut?: string;
  when?: keyof PaletteCapabilities;
  keywords?: readonly string[];
}[];
export type PaletteAction = (typeof ACTIONS)[number]["id"];

const SETTINGS = [
  {
    id: "general",
    label: "General",
    keywords: ["startup", "updates", "notifications"],
  },
  {
    id: "appearance",
    label: "Appearance",
    keywords: ["theme", "font", "size", "colors", "chat width", "typography"],
  },
  {
    id: "models",
    label: "Models",
    keywords: ["default", "favorites", "reasoning"],
  },
  {
    id: "providers",
    label: "Agents",
    keywords: ["claude", "codex", "cursor", "providers", "login"],
  },
  {
    id: "cloud-computer",
    label: "Cloud Computer",
    keywords: ["recipe", "snapshot", "organization"],
  },
  { id: "browser-use", label: "Browser", keywords: ["chrome", "automation"] },
  {
    id: "computer-use",
    label: "Computer use",
    keywords: ["desktop", "automation"],
  },
  {
    id: "simulators",
    label: "Simulators",
    keywords: ["ios", "android", "device"],
  },
  {
    id: "terminal-agents",
    label: "Terminal Agents",
    keywords: ["shell", "cli"],
  },
  {
    id: "environment",
    label: "Environment",
    keywords: ["variables", "secrets", "env"],
  },
  {
    id: "git",
    label: "Git & PR",
    keywords: ["branch", "commit", "pull request"],
  },
  {
    id: "integrations",
    label: "Integrations",
    keywords: ["github", "account", "connect"],
  },
  { id: "account", label: "Profile", keywords: ["account", "name"] },
  { id: "experimental", label: "Experimental", keywords: ["features"] },
] as const;
export type PaletteSettingsSection = (typeof SETTINGS)[number]["id"];

export type PaletteTarget =
  | { type: "workspace"; workspace: Workspace }
  | { type: "chat"; chatId: string; folder: string; workspace: Workspace }
  | { type: "file"; folder: string; path: string }
  | { type: "action"; action: PaletteAction }
  | { type: "settings"; section: PaletteSettingsSection }
  | { type: "theme"; mode: "light" | "dark" | "system" };

export interface PaletteEntry {
  id: string;
  category: Exclude<PaletteCategory, "all">;
  group: string;
  label: string;
  detail?: string;
  icon: PaletteIcon;
  shortcut?: string;
  keywords?: readonly string[];
  timestamp?: number;
  target: PaletteTarget;
}

/** cmdk trims values. Encode identity parts so literal trailing spaces and
 * separators remain distinct while the target keeps the original path/ID. */
function dynamicEntryId(kind: "workspace" | "chat" | "file", ...parts: string[]) {
  return [kind, ...parts.map((part) => encodeURIComponent(part))].join(":");
}

/** A persisted organization can be known before its membership snapshot arrives.
 * Never use the shared filter's null-owner fallback to expose other owners here. */
export function paletteWorkspacesForOwner(
  rows: Workspace[],
  organization: OrganizationSummary | null,
  confirmedId: string | null,
): Workspace[] {
  if (!organization && confirmedId) {
    return filterRowsForOrganization(rows, null).filter(
      (row) => row.organizationId === confirmedId,
    );
  }
  return filterRowsForOrganization(rows, organization ?? PERSONAL_ORGANIZATION);
}

export function workspacePaletteEntries(
  rows: Workspace[],
  projects: readonly Project[],
  filter: PaletteWorkspaceFilter,
): PaletteEntry[] {
  return [...new Map(rows.map((row) => [row.id, row])).values()]
    .filter(
      (row) =>
        filter === "all" ||
        workspaceIsReadOnly(row) === (filter === "archived"),
    )
    .sort(
      (a, b) =>
        (b.lastActiveAt ?? b.createdAt) - (a.lastActiveAt ?? a.createdAt) ||
        a.id.localeCompare(b.id),
    )
    .map((workspace) => ({
      id: dynamicEntryId("workspace", workspace.id),
      category: "workspaces",
      label: workspaceLabel(workspace),
      group: workspaceIsReadOnly(workspace)
        ? "Archived workspaces"
        : "Workspaces",
      detail: [
        projects.find((project) => project.repoSlug === workspace.repoSlug)
          ?.name ?? workspace.repoSlug,
        isCloudWorkspace(workspace.path) ? "Cloud" : "Local",
        workspace.present === false
          ? "Folder missing"
          : workspace.archivedAt != null
            ? "Archived"
            : undefined,
      ]
        .filter(Boolean)
        .join(" · "),
      keywords: [workspace.branch, workspace.repoSlug],
      icon: isCloudWorkspace(workspace.path) ? "cloud" : "workspace",
      timestamp: workspace.lastActiveAt ?? workspace.createdAt,
      target: { type: "workspace", workspace },
    }));
}

export function chatPaletteEntries(
  chats: ChatThread[],
  visibleWorkspaces: Workspace[],
  allWorkspaces: Workspace[],
  now: number,
): PaletteEntry[] {
  const visibleIds = new Set(
    visibleWorkspaces.map((workspace) => workspace.id),
  );
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const day = 86_400_000;
  return chats
    .filter((chat) => !chat.archived)
    .flatMap((chat) => {
      // Resolve against ALL owners before filtering. An unrelated nested
      // workspace must not be absorbed by a visible parent checkout.
      const workspace = paletteWorkspaceForFolder(chat.folder, allWorkspaces);
      if (
        !workspace ||
        !visibleIds.has(workspace.id) ||
        workspace.kind === "design"
      )
        return [];
      const age = today.getTime() - chat.updatedAt;
      return [
        {
          id: dynamicEntryId("chat", chat.id),
          category: "chats" as const,
          group:
            age <= 0
              ? "Today"
              : age <= day
                ? "Yesterday"
                : age <= 7 * day
                  ? "Last 7 days"
                  : "Older",
          label: chat.title || "Untitled chat",
          detail: workspaceLabel(workspace),
          keywords: [
            chat.agentName ?? "",
            workspace.branch,
            workspace.repoSlug,
          ],
          icon:
            chat.kind === "terminal"
              ? ("terminal" as const)
              : ("chat" as const),
          timestamp: chat.updatedAt,
          target: {
            type: "chat" as const,
            chatId: chat.id,
            folder: chat.folder,
            workspace,
          },
        },
      ];
    })
    .sort((a, b) => b.timestamp - a.timestamp || a.id.localeCompare(b.id));
}

/** Resolve the most specific registered owner before applying visibility. */
export function paletteWorkspaceForFolder(
  folder: string,
  workspaces: readonly Workspace[],
): Workspace | null {
  let owner: Workspace | null = null;
  for (const workspace of workspaces) {
    if (
      folderIsWithinRoot(folder, workspace.path) &&
      (!owner || folderIsWithinRoot(workspace.path, owner.path))
    )
      owner = workspace;
  }
  return owner;
}

export function filePaletteEntries(
  folder: string,
  paths: string[],
  query: string,
  recent: string[],
): PaletteEntry[] {
  const candidates = query.trim()
    ? searchWorkspaceFiles(paths, query, 80).map((result) => result.path)
    : [
        ...new Set([
          ...recent.filter((path) => paths.includes(path)),
          ...paths,
        ]),
      ].slice(0, 80);
  return candidates.map((path) => {
    const slash = path.lastIndexOf("/");
    return {
      id: dynamicEntryId("file", folder, path),
      category: "files",
      group: "Files",
      label: path.slice(slash + 1),
      detail: slash < 0 ? undefined : path.slice(0, slash),
      icon: "file",
      target: { type: "file", folder, path },
    };
  });
}

export function actionPaletteEntries(
  capabilities: PaletteCapabilities,
): PaletteEntry[] {
  return ACTIONS.filter(
    (action) => !("when" in action) || capabilities[action.when],
  ).map((action) => ({
    ...action,
    id: `action:${action.id}`,
    category: "actions",
    target: { type: "action", action: action.id },
  }));
}

export function settingsPaletteEntries(
  context: SettingsSectionAvailability,
): PaletteEntry[] {
  const entries: PaletteEntry[] = SETTINGS.filter((section) =>
    isSettingsSectionAvailable(section.id, context),
  ).map((section) => ({
    ...section,
    id: `settings:${section.id}`,
    category: "settings",
    group: "Settings",
    icon: "settings",
    target: { type: "settings", section: section.id },
  }));
  for (const mode of ["light", "dark", "system"] as const) {
    entries.push({
      id: `theme:${mode}`,
      category: "settings",
      group: "Appearance",
      label: `${mode[0].toUpperCase()}${mode.slice(1)} theme`,
      icon: mode === "light" ? "sun" : mode === "dark" ? "moon" : "system",
      keywords: ["appearance", "color"],
      target: { type: "theme", mode },
    });
  }
  return entries;
}

/** Filter before rendering: cmdk supplies selection/navigation while even a
 * large workspace/file catalog creates at most 100 interactive DOM rows. */
export function selectPaletteEntries(
  entries: PaletteEntry[],
  category: PaletteCategory,
  query: string,
): PaletteEntry[] {
  const searching = !!query.trim();
  const counts = new Map<PaletteEntry["category"], number>();
  return entries
    .filter((entry) => category === "all" || entry.category === category)
    .map((entry, index) => ({
      entry,
      index,
      // Files already have path-aware fuzzy ranking from the shared quick-open.
      score:
        !searching || entry.category === "files"
          ? 1
          : defaultFilter(entry.label, query.trim(), [
              entry.detail ?? "",
              entry.group,
              ...(entry.keywords ?? []),
            ]),
    }))
    .filter((row) => row.score > 0)
    .sort((a, b) =>
      searching ? b.score - a.score || a.index - b.index : a.index - b.index,
    )
    .filter(({ entry }) => {
      const count = counts.get(entry.category) ?? 0;
      const limit =
        category !== "all"
          ? 100
          : searching
            ? 20
            : ["workspaces", "chats", "files"].includes(entry.category)
              ? 5
              : 30;
      counts.set(entry.category, count + 1);
      return count < limit;
    })
    .slice(0, 100)
    .map(({ entry }) => entry);
}
