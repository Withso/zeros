import {
  isSettingsSectionAvailable,
  settingsSectionForRail,
  UNIFIED_ORGANIZATION_SECTIONS,
  UNIFIED_PERSONAL_SECTIONS,
} from "./settings-section-availability";
import { LocalStoragePanel } from "./local-storage-panel";
import {
  cancelLocalStorageMeasurement,
  isLocalStorageSupported,
  warmLocalStorage,
} from "./local-storage-store";
import { CloudComputerPanel } from "./cloud-computer-panel";
import { prefetchCloudComputer, useCloudComputerRepositories } from "./cloud-computer-store";
import { CLOUD_REPOSITORY_TABS, CloudRepositoryPanel, type CloudRepositoryTab } from "./cloud-repository-panel";
import { CloudGithubSection } from "./cloud-github-section";
import { EnvironmentPanel } from "./environment-panel";
import { KeepAwakeSetting } from "./keep-awake-setting";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from "react";
import "./settings-page.css";
import { useRetainedViewKeys } from "../../shell/use-retained-view-keys";
import { useScrollMemoryRef } from "../../shell/scroll-memory";
import { useInstantViewSwitch } from "../../shared/ui/use-instant-view-switch";
import {
  Palette,
  Settings,
  ArrowLeft,
  Astroid,
  SquareTerminal,
  Blocks,
  KeyRound,
  Box,
  FolderGit2,
  GitPullRequest,
  FlaskConical,
  CircleUser,
  CircleCheck,
  LogOut,
  UserPlus,
  Lock,
  Globe2,
  HardDrive,
  Smartphone,
  Trash2,
  Building2,
  MousePointerClick,
  Users,
  ArrowUpRight,
  type LucideIcon,
} from "lucide-react";
import {
  useActivePage,
  useWorkspaceDispatch,
  useWorkspaceStore,
  selectActiveFolder,
} from "../../state/store";
import { useRecoveringRead } from "../../state/use-recovering-read";
import {
  providerMemorySettingsCache,
  PROVIDER_DIAGNOSTIC_MAX_AGE_MS,
} from "../../state/read-caches";
import { Button, GithubIcon } from "../../shared/ui";
import { isLocalDevelopment, useNativeRuntime } from "../../platform/runtime";
import { toast } from "@/renderer/shared/ui/primitives/elements";
import { cn } from "@/renderer/shared/ui/cn";
import { Switch } from "../../shared/ui/primitives/switch";
import { Avatar, AvatarFallback } from "../../shared/ui/primitives/avatar";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../../shared/ui/primitives/tabs";
import {
  Dialog,
  DialogContent,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../shared/ui/primitives/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../shared/ui/primitives/select";
import { useAppearance } from "../../shared/theme/provider";
import { CHAT_WIDTH_OPTIONS, type ChatWidth, type ThemeMode } from "../../shared/theme/prefs";
import { codeThemesForVariant } from "../../shared/theme/code-themes";
import { useThemeVariant } from "../../shared/theme/use-theme-variant";
import { CodeThemePreview } from "./code-theme-preview";
import { useOrganizationProjects } from "../../state/use-organization-projects";
import { ProvidersPanel } from "./providers-panel";
import { BrowserUsePanel } from "./browser-use-panel";
import {
  ComputerPermissionRows,
  ComputerUseSettingsSection,
} from "./computer-use-panel";
import { computerUseSectionOpen } from "./computer-use-settings";
import { SimulatorsPanel } from "./simulators-panel";
import { TerminalAgentsSection } from "./terminal-agents-section";
import { GitDefaultsSection } from "./git-defaults-section";
import { useExperimentalFeature } from "./experimental-features";
import {
  setShowHiddenWorkspaces,
  useShowHiddenWorkspaces,
} from "./dashboard-settings";
import { useInternalFeature, useIsInternalUser } from "./internal-features";
import { FollowUpBehaviorSetting } from "./follow-up-behavior-setting";
import { FullDiskAccessRow } from "./full-disk-access-row";
import {
  setRestartAutomaticallyOnUpdate,
  useRestartAutomaticallyOnUpdate,
} from "./update-settings";
import {
  AGENT_CONTROL_FEATURE_ROWS,
  agentControlFeaturesAt,
  useAgentControlFeatureActive,
} from "./agent-control-rollout";
import type { AgentControlFeature } from "@zeros/protocol/agent-control-rollout";
import {
  isRepoSectionId,
  type RepoSectionId,
} from "../repositories/repositories-panel";
import { repoPageViewForSection } from "../repositories/repo-page";
import { OpenSettingsFileButton } from "../../shared/ui/open-settings-file-button";
import { GitHubSection } from "./github-section";
import { prefetchGithubAuthSnapshot } from "./github-auth-prefetch";
import { JoinTeamDialog } from "../team/join-team-dialog";
import { OrganizationSwitcher } from "../team/organization-switcher";
import { TRAFFIC_LIGHT_RESERVE_CLS } from "../../shell/sidebar-toggle";
import { getActiveOrganizationIdSnapshot, useActiveOrganization, useTeams } from "../team/team-store";
import { WorkspaceApiAccessSetting } from "./workspace-api-access-setting";
import { AlwaysAllowLocalCommands } from "./local-commands-settings";
import { organizationGeneralSections, unifiedOrganizationGeneralSections } from "./organization-general";
import { hasCloudWorkspaceAccountAccess } from "../team/cloud-workspace-account-access";
import { readScopedSettingsSelection, writeScopedSettingsSelection, settingsOwnerKey } from "./settings-scope";
import { retainedDialogOpen } from "./retained-surface";
import {
  consumePendingInviteToken,
  subscribePendingInvite,
} from "../team/invite-link";
import { isAnalyticsOptedOut } from "../../platform/observability/analytics/consent";
import { setAnalyticsEnabled } from "../../platform/observability/analytics/posthog";
import { useAuth } from "../auth";
import {
  accountAuthenticationProvider,
  accountAuthenticationProviderLabel,
} from "./account-authentication-provider";
import { useBridge, useBridgeStatus } from "../../platform/bridge/use-bridge";
import { ensureSettingsTomlMigrated } from "./migrate-legacy";
import { subscribeUserSettingsSection } from "./settings-navigation";
import {
  SETTINGS_CARD_LIST_CLS,
  SettingsGroup,
  SettingsList,
  SettingsRow,
  SettingsSection,
} from "./settings-ui";
import { useAgentSessions } from "../agent/sessions-hooks";
import { useEnabledAgents } from "../agent/enabled-agents";
import { loadAgents } from "../agent/agents-cache";
import { useWorkspaceAgents } from "../agent/workspace-agent-registry";
import { isCloudWorkspace } from "../../platform/bridge/cloud-workspace-key";
import { isSelectableAgent } from "../agent/agent-runnable";
import {
  agentFamily,
  displayModelLabel,
  modelsForAgent,
} from "../agent/model-catalog";
import {
  effectiveFavoriteModel,
  getFavoriteModel,
  useFavoritesVersion,
} from "../agent/model-favorites";
import {
  mirrorModelsToSettings,
  modelForNewChat,
  starFavoriteModel,
  useDefaultPlanMode,
} from "../agent/new-chat-defaults";
import { ClaudeProviderSettings } from "./claude-provider-settings";
import { useDefaultAgent, pickDefaultAgentId } from "./default-agent";
import type { AgentMemorySettings } from "@zeros/protocol/agent-events";

import { popoverBoundaryProps } from "@/renderer/shared/ui/popover-boundary";
import { CHANNEL, isFeatureEnabled } from "../../config/release-channel";
import { PlaceLabel } from "./settings-ui";
import { ProjectPage, settingsProjects, type SettingsProject } from "./project-page";
import { useCloudComputerV2CreateGate } from "./cloud-computer-v2-create-gate";
import { shellOpenUrl } from "../../platform/app";
import { APP_BASE_URL, organizationDashboardUrl } from "../team/organization-links";
import { CloudWorkspacePausedNotice } from "../team/cloud-workspace-pause";
type SectionId =
  | "general"
  | "computer-use"
  | "org-general"
  | "appearance"
  | "models"
  | "local-storage"
  | "providers"
  | "browser-use"
  | "simulators"
  | "terminal-agents"
  | "environment"
  | "git"
  | "repos"
  | "cloud-computer"
  | "integrations"
  | "account"
  | "experimental"
  | "internal";

type NavIcon = LucideIcon | typeof GithubNavIcon;

type SectionDef = {
  id: SectionId;
  label: string;
  /** The unified rail's name for a page whose content changed. */
  unifiedLabel?: string;
  /** One line under the title for every owner. */
  description?: string;
  icon: NavIcon;
  unifiedIcon?: NavIcon;
  navClassName?: string;
  Panel: ComponentType<{ surfaceActive?: boolean; unified?: boolean; openCloudRepository?(repository: string): void }>;
};

function GithubNavIcon({ size }: { size?: number }) {
  return <GithubIcon width={size} height={size} />;
}

// Override every state modifier; twMerge does not replace across modifiers.
const INTERNAL_NAV_CLS =
  "text-brown-primary hover:text-brown-primary data-[state=active]:text-brown-primary data-[state=active]:hover:text-brown-primary [&>svg]:text-brown-primary data-[state=active]:[&>svg]:text-brown-primary";

const SECTIONS: SectionDef[] = [
  {
    id: "general",
    label: "General",
    icon: Settings,
    Panel: GeneralPanel,
  },
  {
    id: "appearance",
    label: "Appearance",
    icon: Palette,
    Panel: AppearancePanel,
  },
  {
    id: "models",
    label: "Models",
    icon: Box,
    Panel: ModelsPanel,
  },
  {
    id: "local-storage",
    label: "Local Storage",
    description: "What Zeros keeps on this Mac.",
    icon: HardDrive,
    Panel: LocalStoragePanel,
  },
  { id: "cloud-computer", label: "Cloud Computer", icon: Box, Panel: CloudComputerPanel },
  {
    id: "providers",
    label: "Agents",
    icon: Astroid,
    Panel: ProvidersPanel,
  },
  {
    id: "browser-use",
    label: "Browser",
    icon: Globe2,
    Panel: BrowserUsePanel,
  },
  {
    id: "simulators",
    label: "Simulators",
    icon: Smartphone,
    Panel: SimulatorsPanel,
  },
  {
    id: "terminal-agents",
    label: "Terminal Agents",
    icon: SquareTerminal,
    Panel: TerminalAgentsPanel,
  },
  {
    id: "environment",
    label: "Environment",
    icon: KeyRound,
    Panel: EnvironmentPanel,
  },
  {
    id: "git",
    label: "Git & PR",
    icon: GitPullRequest,
    Panel: GitDefaultsPanel,
  },
  {
    id: "integrations",
    label: "Integrations",
    unifiedLabel: "GitHub",
    icon: Blocks,
    unifiedIcon: GithubNavIcon,
    Panel: IntegrationsPanel,
  },
  {
    id: "computer-use",
    label: "Computer use",
    description: "Only in local workspaces.",
    icon: MousePointerClick,
    Panel: ComputerUsePanel,
  },
  { id: "org-general", label: "General", icon: Building2, Panel: OrganizationGeneralPanel },
  {
    id: "account",
    label: "Profile",
    icon: CircleUser,
    Panel: AccountPanel,
  },
  {
    id: "experimental",
    label: "Experimental",
    icon: FlaskConical,
    Panel: ExperimentalPanel,
  },
  {
    id: "internal",
    label: "Internal",
    icon: Lock,
    navClassName: INTERNAL_NAV_CLS,
    Panel: InternalPanel,
  },
];

const SECTION_GROUPS: Array<{ label: string; ids: SectionId[] }> = [
  {
    label: "Personal",
    ids: [
      "general",
      "appearance",
      "local-storage",
      "experimental",
      "account",
      "integrations",
      "internal",
    ],
  },
  {
    label: "Agents",
    ids: ["models", "providers", "browser-use", "simulators", "terminal-agents"],
  },
  { label: "Workspace", ids: ["cloud-computer", "environment", "git"] },
];

const REPO_OVERVIEW = "overview" as const;

type RepoPage = RepoSectionId | typeof REPO_OVERVIEW;

// Keep persisted selection and deep-link IDs stable across label renames.
type Selection =
  | { scope: "user"; section: SectionId }
  | { scope: "repo"; repoId: string; section: RepoPage }
  | { scope: "cloud-repo"; repository: string; tab: CloudRepositoryTab }
  | { scope: "project"; key: string };

function userSelection(section: SectionId): string {
  return `user:${section}`;
}

function repoSelection(repoId: string, section: RepoPage): string {
  return `repo:${repoId}:${section}`;
}

function cloudRepoSelection(repository: string, tab: CloudRepositoryTab): string {
  return `cloud-repo:${tab}:${repository}`;
}

function isRepoPage(value: string): value is RepoPage {
  return value === REPO_OVERVIEW || isRepoSectionId(value);
}

function isStaticSection(value: string): value is SectionId {
  return (VALID_STATIC_SECTIONS as readonly string[]).includes(value);
}

// Older installs saved bare section IDs and sectionless repo links.
function parseSelection(active: string, fallback: SectionId = "general", unified = false): Selection {
  // The unified rail's joined project page; the old rail shows its fallback without rewriting the save.
  if (active.startsWith("project:")) {
    const key = active.slice("project:".length);
    return unified && key ? { scope: "project", key } : { scope: "user", section: fallback };
  }
  if (active.startsWith("cloud-repo:")) {
    const rest = active.slice("cloud-repo:".length), colon = rest.indexOf(":");
    const tab = rest.slice(0, colon), repository = rest.slice(colon + 1);
    const known = CLOUD_REPOSITORY_TABS.find((item) => item.id === tab);
    return known && /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(repository)
      ? { scope: "cloud-repo", repository, tab: known.id }
      : { scope: "user", section: "cloud-computer" };
  }
  if (active.startsWith("repo:")) {
    const rest = active.slice("repo:".length);
    // The legacy empty repo sentinel means the list, not a repository.
    if (!rest) return { scope: "user", section: "repos" };
    const lastColon = rest.lastIndexOf(":");
    if (lastColon > 0) {
      const raw = rest.slice(lastColon + 1);
      // Redirect retired repository sections to Environment.
      const maybeSection =
        raw === "scripts" || raw === "run-actions" || raw === "mcp" ||
        raw === "design" || raw === "design-preferences"
          ? "environment"
          : raw;
      if (isRepoPage(maybeSection)) {
        return {
          scope: "repo",
          repoId: rest.slice(0, lastColon),
          section: maybeSection,
        };
      }
    }
    return { scope: "repo", repoId: rest, section: REPO_OVERVIEW };
  }
  const rawBare = active.startsWith("user:")
    ? active.slice("user:".length)
    : active;
  // Computer use lives in General outside the unified rail; mapping on read keeps the saved ID for either rail.
  const bare = settingsSectionForRail(rawBare, unified);
  return { scope: "user", section: isStaticSection(bare) ? bare : fallback };
}

const PAGE_HEADING_CLS = "m-0 text-lg leading-6 font-medium text-fg1";
const NO_CLOUD_REPOSITORIES: readonly string[] = [];
const NO_SETTINGS_PROJECTS: SettingsProject[] = [];

const HINT_CLS = "m-0 text-3xxs leading-4 text-fg3";

const VALID_STATIC_SECTIONS: SectionId[] = SECTIONS.map((s) => s.id);

// Finder needs a file to select even before the first settings write.
const USER_SETTINGS_SEED = `# Zeros user settings (this Mac).
# Values you set in Settings are saved here.
`;

function loadInitialSection(owner: string, unified: boolean): string {
  const sel = parseSelection(
    readScopedSettingsSelection(owner, "section", owner === "local" ? "user:general" : "user:providers"),
    owner === "local" ? "general" : "providers",
    unified,
  );
  return sel.scope === "user"
    ? userSelection(sel.section)
    : sel.scope === "repo"
      ? repoSelection(sel.repoId, sel.section)
      : sel.scope === "project"
        ? `project:${sel.key}`
        : cloudRepoSelection(sel.repository, sel.tab);
}

const SIDEBAR_ENTRY_CLS =
  "flex h-8 w-full min-w-0 items-center justify-start gap-2 rounded-md border-0 bg-transparent px-2 py-0 text-left text-xs leading-4.5 font-normal text-fg2 transition-colors duration-120 ease-out hover:bg-sidebar-bg-hover hover:text-fg1 data-[state=active]:bg-bg2-highlight data-[state=active]:text-fg1 data-[state=active]:hover:bg-bg2-highlight [&_svg]:size-3.5 [&>svg]:shrink-0 [&>svg]:text-fg3 data-[state=active]:[&>svg]:text-fg2";

const SETTINGS_GROUP_HEADER_CLS =
  "select-none px-2 pt-4 pb-1 text-3xxs leading-4 font-medium text-fg3";

const SETTINGS_GROUP_RULE_CLS = "bg-border1 mx-2 my-2 h-px shrink-0";

const ORGANIZATION_SECTION_DESCRIPTIONS: Partial<Record<SectionId, string>> = {
  providers: "Your accounts are private to you.",
};

export function SettingsPage() {
  const organization = useActiveOrganization();
  const { me } = useTeams();
  const organizationId = organization?.isPersonal ? null : organization?.id ?? getActiveOrganizationIdSnapshot();
  const owner = settingsOwnerKey(me?.user.id ?? "pending", organizationId);
  // Remount on owner changes so retained panels, secrets and drafts cannot cross owners.
  return <ScopedSettingsPage key={owner} owner={owner} />;
}

function ScopedSettingsPage({ owner }: { owner: string }) {
  const local = owner === "local";
  const cloudEnabled = isFeatureEnabled("cloud-workspaces");
  const unified = isFeatureEnabled("unified-workspaces");
  const organization = useActiveOrganization();
  const { me } = useTeams();
  const pageSurfaceRef = useRef<HTMLDivElement | null>(null);
  const dispatch = useWorkspaceDispatch();
  const pageActive = useActivePage() === "settings";
  const { projects } = useOrganizationProjects();
  const [active, setActiveState] = useState<string>(() => loadInitialSection(owner, unified));
  const setActive = useCallback((next: string) => {
    setActiveState(next);
    writeScopedSettingsSelection(owner, "section", next);
  }, [owner]);
  const selection = parseSelection(active, local ? "general" : "providers", unified);
  useInstantViewSwitch(`settings:${owner}:${active}`, pageSurfaceRef);

  // A retained page will not reread persisted selection when a deep link opens it.
  useEffect(
    () =>
      subscribeUserSettingsSection((section) => {
        if (isStaticSection(section)) {
          setActiveState(userSelection(section));
        }
      }, owner),
    [owner],
  );

  const [joinTeamOpen, setJoinTeamOpen] = useState(false);
  const [joinToken, setJoinToken] = useState("");

  // Consume a legacy invite link whether it arrives before or after mount.
  useEffect(() => {
    const takePending = () => {
      const token = consumePendingInviteToken();
      if (!token) return;
      setJoinToken(token);
      setJoinTeamOpen(true);
    };
    takePending();
    return subscribePendingInvite(takePending);
  }, []);

  const bridge = useBridge();
  useEffect(() => {
    // The engine guards this legacy import and preserves existing TOML values.
    if (local || unified) void ensureSettingsTomlMigrated(bridge);
  }, [bridge, local, unified]);

  const prevProjectsLenRef = useRef(projects.length);
  useEffect(() => {
    const prevLen = prevProjectsLenRef.current;
    prevProjectsLenRef.current = projects.length;
    const sel = parseSelection(active, "general", unified);
    // The unified rail opens a saved repository on its project page instead.
    if (sel.scope !== "repo" || !local || unified) return;
    // Keep a saved repo route until the project list can resolve it.
    if (projects.length === 0 && prevLen === 0) return;
    const project = projects.find((p) => p.id === sel.repoId);
    if (project) {
      dispatch({
        type: "OPEN_REPO_PAGE",
        projectId: project.id,
        view: repoPageViewForSection(sel.section),
      });
    }
    setActive(userSelection("general"));
  }, [projects, active, dispatch, local, setActive, unified]);

  // Startup restore normalizes legacy MCP to the owner's fallback; only raw routes can redirect.
  useEffect(() => {
    const bare = active.startsWith("user:")
      ? active.slice("user:".length)
      : active;
    if (bare !== "mcp") return;
    setActive(userSelection("general"));
    dispatch({ type: "SET_ACTIVE_PAGE", page: "customize" });
  }, [active, dispatch, setActive]);
  const [terminalAgentsEnabled] = useExperimentalFeature("terminalAgents");
  const internalUser = useIsInternalUser();
  const computerUseSectionActive = computerUseSectionOpen({
    computerUse: useAgentControlFeatureActive("computerUse"),
    zerosBrowser: useAgentControlFeatureActive("zerosBrowser"),
  });
  const simulatorsActive = useAgentControlFeatureActive("simulators");
  const localStorageSupported = useNativeRuntime().ready && isLocalStorageSupported();
  // A walk started by hovering the entry stops when Settings closes.
  useEffect(() => {
    if (!pageActive) cancelLocalStorageMeasurement();
  }, [pageActive]);
  const organizationGeneral =
    unified &&
    unifiedOrganizationGeneralSections(
      organization,
      !!organization && hasCloudWorkspaceAccountAccess(organization.id),
    ).length > 0;
  // Enforce feature gates on restored and deep-linked routes, not just sidebar rows.
  const availableSections = useMemo(
    () =>
      SECTIONS.filter((section) => isSettingsSectionAvailable(section.id, {
        local, cloudEnabled, terminalAgentsEnabled, computerUseSectionActive,
        simulatorsActive, internalUser, localStorageSupported, unified, organizationGeneral,
      })),
    [
      terminalAgentsEnabled, internalUser, local, cloudEnabled,
      computerUseSectionActive, simulatorsActive, localStorageSupported, unified, organizationGeneral,
    ],
  );
  const fallbackSection =
    availableSections.find((s) => s.id === (local ? "general" : "providers")) ??
    availableSections[0];
  const availableSectionIds = useMemo(
    () => new Set(availableSections.map((section) => section.id)),
    [availableSections],
  );
  const cloudRepositories = useCloudComputerRepositories(me?.user.id ?? null,
    !local && availableSectionIds.has("cloud-computer") ? organization : null, pageActive);
  // unified-workspaces: one page per joined project. Members read the installed
  // repositories; owners and admins also see what their recipe adds.
  const installedCloud = useCloudComputerV2CreateGate(pageActive && unified && !local).repositories;
  const projectCloudKey = unified && !local
    ? [...new Set([...cloudRepositories, ...(installedCloud ?? []).map(row => `${row.owner}/${row.name}`)])].join("\n")
    : "";
  const projectCloudNames = useMemo(() => (projectCloudKey ? projectCloudKey.split("\n") : NO_CLOUD_REPOSITORIES), [projectCloudKey]);
  const joinedProjects = useMemo(
    () => (unified ? settingsProjects(projects, projectCloudNames) : NO_SETTINGS_PROJECTS),
    [unified, projects, projectCloudNames],
  );
  const currentProject: SettingsProject | undefined = !unified ? undefined
    : selection.scope === "project" ? joinedProjects.find(project => project.key === selection.key)
    : selection.scope === "repo" ? joinedProjects.find(project => project.local.some(folder => folder.id === selection.repoId))
    : selection.scope === "cloud-repo"
      ? joinedProjects.find(project => project.cloudRepository?.toLowerCase() === selection.repository.toLowerCase())
      : undefined;
  const activeSection: SectionDef | null =
    selection.scope === "user"
      ? (availableSections.find((s) => s.id === selection.section) ??
        fallbackSection)
      : currentProject ? null
      : unified ? fallbackSection
      : local || selection.scope === "cloud-repo" ? null : fallbackSection;
  // Persist the fallback so reopening a gate cannot restore a retired selection.
  const selectedSection = selection.scope === "cloud-repo" || selection.scope === "project" ? null : selection.section;
  useEffect(() => {
    // A saved project may resolve once its lists load; keep it rather than rewrite it.
    if (unified && selection.scope !== "user") return;
    if (selection.scope === "repo" && local) return;
    if (selection.scope === "user" && availableSections.some((s) => s.id === selectedSection)) return;
    if (selection.scope === "cloud-repo" && availableSections.some((s) => s.id === "cloud-computer")) return;
    const fallback = fallbackSection?.id;
    if (fallback) setActive(userSelection(fallback));
  }, [availableSections, fallbackSection, selection.scope, selectedSection, local, setActive, unified]);
  const openCloudRepository = useCallback((repository: string) => setActive(cloudRepoSelection(repository, "git")), [setActive]);
  // Keep visited panels mounted to preserve drafts across navigation.
  const sectionIdsToRender = useRetainedViewKeys(
    activeSection?.id ?? null,
    availableSections.length,
    availableSectionIds,
  );

  // Hiding a panel clamps the shared scroller, so restore offsets by section.
  const detailScrollRef = useScrollMemoryRef(
    activeSection ? `settings:${owner}:${activeSection.id}` : null,
  );

  const handleBack = () => {
    dispatch({ type: "SET_ACTIVE_PAGE", page: "dashboard" });
  };

  const renderSectionNav = (section: SectionDef) => (
    <SectionNavButton
      key={section.id}
      icon={(unified && section.unifiedIcon) || section.icon}
      label={(unified && section.unifiedLabel) || section.label}
      className={section.navClassName}
      isActive={
        selection.scope === "user" &&
        selection.section === section.id
      }
      onClick={() => setActive(userSelection(section.id))}
      onIntent={
        section.id === "integrations"
          ? prefetchGithubAuthSnapshot
          : section.id === "local-storage"
            ? warmLocalStorage
          : section.id === "cloud-computer" && organization && me
            ? () => prefetchCloudComputer(me.user.id, organization)
          : undefined
      }
    />
  );
  const renderCloudRepositoryNav = (repository: string) => {
    const current = selection.scope === "cloud-repo" && selection.repository === repository;
    return (
      <SectionNavButton key={repository} icon={FolderGit2} label={repository} isActive={current}
        onClick={() => setActive(cloudRepoSelection(repository, current ? selection.tab : "git"))} />
    );
  };
  const unifiedGroups: Array<{ key: string; label: string; ids: readonly string[] }> = [
    { key: "personal", label: "Personal", ids: UNIFIED_PERSONAL_SECTIONS },
    ...(local
      ? []
      : [{ key: "organization", label: organization?.name ?? "Organization", ids: UNIFIED_ORGANIZATION_SECTIONS }]),
  ];

  const fileScopeControls = local || unified ? (
    <OpenSettingsFileButton
      layer="user"
      label="Open settings.toml"
      tooltip="~/.zeros/settings.toml — reveal in Finder"
      seed={USER_SETTINGS_SEED}
    />
  ) : null;

  return (
    <div
      ref={pageSurfaceRef}
      className="bg-sidebar-bg flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden"
    >
      <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <div className="flex min-h-0 shrink-0 basis-[256px] flex-col">
          <div
            data-tauri-drag-region
            className="flex h-10 shrink-0 items-center justify-between pr-3"
          >
            <div className={TRAFFIC_LIGHT_RESERVE_CLS} aria-hidden="true" />
            <Button
              variant="ghost"
              size="compact"
              className="text-fg2 hover:bg-sidebar-bg-hover hover:text-fg1"
              onClick={handleBack}
            >
              <ArrowLeft strokeWidth={1.5} />
              <span>Back</span>
            </Button>
          </div>
          <nav
            className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pt-2 pb-2"
            role="tablist"
            aria-label="Settings sections"
          >
            <OrganizationSwitcher />
            {unified ? (
              <>
                {unifiedGroups.map((group) => {
                  const sections = group.ids.flatMap((id) => {
                    const section = availableSections.find((s) => s.id === id);
                    return section ? [section] : [];
                  });
                  const members = group.key === "organization" && organization && !organization.isPersonal;
                  if (sections.length === 0 && !members) return null;
                  return (
                    <React.Fragment key={group.key}>
                      <div className={SETTINGS_GROUP_HEADER_CLS}>{group.label}</div>
                      <div className="flex flex-col gap-0.5">
                        {sections.filter((section) => section.id === "org-general").map((section) => renderSectionNav(section))}
                        {members && (
                          <SectionNavButton icon={Users} label="Members" isActive={false} external
                            onClick={() => void shellOpenUrl(organizationDashboardUrl(APP_BASE_URL, { organizationId: organization.id, section: "members" }))} />
                        )}
                        {sections.filter((section) => section.id !== "org-general").map((section) => renderSectionNav(section))}
                      </div>
                    </React.Fragment>
                  );
                })}
                {joinedProjects.length > 0 && (
                  <>
                    <div className={SETTINGS_GROUP_HEADER_CLS}>Projects</div>
                    <div className="flex flex-col gap-0.5">
                      {joinedProjects.map((project) => (
                        <SectionNavButton key={project.key} icon={FolderGit2} label={project.label}
                          isActive={currentProject?.key === project.key}
                          onClick={() => setActive(`project:${project.key}`)} />
                      ))}
                    </div>
                  </>
                )}
              </>
            ) : (
              <>
                {SECTION_GROUPS.map((group, groupIndex) => {
                  const sections = group.ids.flatMap((id) => {
                    const section = availableSections.find((s) => s.id === id);
                    return section ? [section] : [];
                  });
                  if (sections.length === 0) return null;
                  return (
                    <React.Fragment key={group.label}>
                      {groupIndex === 0 || sections.length === 1 ? (
                        <div className={SETTINGS_GROUP_RULE_CLS} aria-hidden="true" />
                      ) : (
                        <div className={SETTINGS_GROUP_HEADER_CLS}>{group.label}</div>
                      )}
                      <div className="flex flex-col gap-0.5">
                        {sections.map((section) => renderSectionNav(section))}
                      </div>
                    </React.Fragment>
                  );
                })}
                {cloudRepositories.length > 0 && (
                  <>
                    {cloudRepositories.length === 1 ? (
                      <div className={SETTINGS_GROUP_RULE_CLS} aria-hidden="true" />
                    ) : (
                      <div className={SETTINGS_GROUP_HEADER_CLS}>Repositories</div>
                    )}
                    <div className="flex flex-col gap-0.5">
                      {cloudRepositories.map((repository) => renderCloudRepositoryNav(repository))}
                    </div>
                  </>
                )}
              </>
            )}
          </nav>
        </div>

        <div className="border-border1 bg-bg1 relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border-l">
          <div className="h-10 shrink-0" data-tauri-drag-region aria-hidden="true" />
          {/* Use native macOS overlay scrollbars; the padding keeps the column cap content-only. */}
          <div
            ref={detailScrollRef}
            className="min-h-0 flex-1 overflow-y-auto px-6"
          >
            <div
              {...popoverBoundaryProps}
              className="settings-type-scale mx-auto w-full max-w-160 pb-12"
            >
              {/* Legacy Local repo links redirect without mounting a Settings panel. */}
              {currentProject && (
                <div className="flex flex-col gap-8">
                  <header className="flex min-w-0 flex-col gap-1">
                    <h1 className={PAGE_HEADING_CLS}>{currentProject.label}</h1>
                    <p className="text-fg2 m-0 truncate text-xs leading-4.5">{currentProject.subtitle}</p>
                  </header>
                  <ProjectPage key={currentProject.key} project={currentProject} surfaceActive={pageActive}
                    cloudAvailable={!local && availableSectionIds.has("cloud-computer")}
                    canManageCloud={organization?.role === "owner" || organization?.role === "admin"}
                    onAddToCloud={() => setActive(userSelection("cloud-computer"))}
                    onOpenCloudComputer={() => setActive(userSelection("cloud-computer"))}
                    onOpenEnvironment={() => setActive(userSelection("environment"))} />
                </div>
              )}
              {!unified && selection.scope === "cloud-repo" && (
                <div className="flex flex-col gap-8">
                  <header className="flex min-w-0 flex-col gap-1">
                    <h1 className={PAGE_HEADING_CLS}>{selection.repository}</h1>
                  </header>
                  <CloudRepositoryPanel key={selection.repository} repository={selection.repository} tab={selection.tab}
                    onTabChange={(tab) => setActive(cloudRepoSelection(selection.repository, tab))}
                    onOpenComputer={() => setActive(userSelection("cloud-computer"))} surfaceActive={pageActive} />
                </div>
              )}
              {sectionIdsToRender.map((sectionId) => {
                const section = availableSections.find(
                  (candidate) => candidate.id === sectionId,
                );
                if (!section) return null;
                const isActive =
                  selection.scope === "user" &&
                  activeSection?.id === section.id;
                const Panel = section.Panel;
                const organizationPage = (UNIFIED_ORGANIZATION_SECTIONS as readonly string[]).includes(section.id);
                const description =
                  (unified && section.id === "org-general" && organization?.name) ||
                  ((unified || (!local && cloudEnabled)) && ORGANIZATION_SECTION_DESCRIPTIONS[section.id]) ||
                  section.description;
                return (
                  <div
                    key={section.id}
                    {...(!isActive ? { inert: "" } : {})}
                    className={isActive ? "flex flex-col gap-8" : "hidden"}
                    aria-hidden={!isActive}
                  >
                    <header className="flex items-start justify-between gap-4">
                      <div className="flex min-w-0 flex-col gap-1">
                        <h1 className={PAGE_HEADING_CLS}>{(unified && section.unifiedLabel) || section.label}</h1>
                        {description && (
                          <p className="text-fg2 m-0 text-xs leading-4.5">{description}</p>
                        )}
                      </div>
                      {!(unified && organizationPage) && fileScopeControls}
                    </header>
                    {!local && !cloudEnabled && <CloudWorkspacePausedNotice />}
                    <Panel surfaceActive={pageActive && isActive} unified={unified} openCloudRepository={openCloudRepository} />
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      <JoinTeamDialog
        open={joinTeamOpen}
        initialToken={joinToken}
        onOpenChange={setJoinTeamOpen}
        onJoined={() => setActive(userSelection("general"))}
      />
    </div>
  );
}

function SectionNavButton({
  icon: Icon,
  label,
  isActive,
  className,
  onClick,
  onIntent,
  external = false,
}: {
  icon: NavIcon;
  label: string;
  isActive: boolean;
  className?: string;
  onClick: () => void;
  onIntent?: () => void;
  /** Opens a page outside the app. */
  external?: boolean;
}) {
  return (
    <Button
      variant="ghost"
      role="tab"
      aria-selected={isActive}
      aria-description={external ? "Opens in your browser" : undefined}
      data-state={isActive ? "active" : "inactive"}
      className={cn(SIDEBAR_ENTRY_CLS, className)}
      onClick={onClick}
      // A React event must not reach prefetch as its optional fetcher.
      onPointerEnter={() => onIntent?.()}
      onFocus={() => onIntent?.()}
    >
      <Icon size={14} />
      <span className="truncate">{label}</span>
      {external && <ArrowUpRight className="ml-auto" aria-hidden />}
    </Button>
  );
}

function GeneralPanel({ surfaceActive = true, unified = false }: { surfaceActive?: boolean; unified?: boolean }) {
  const organization = useActiveOrganization();
  // useActiveOrganization re-renders this panel on every team-store change.
  const cloudAccess = !!organization && hasCloudWorkspaceAccountAccess(organization.id);
  if (unified) return <PersonalGeneralPanel />;
  if (organization ? !organization.isPersonal : Boolean(getActiveOrganizationIdSnapshot())) {
    const sections = organizationGeneralSections(organization, cloudAccess);
    return (
      <div className="flex flex-col gap-8">
        {sections.includes("workspace-api-access") && <WorkspaceApiAccessSetting organizationId={organization!.id} surfaceActive={surfaceActive} />}
        <ComputerUseSettingsSection surfaceActive={surfaceActive} withPermissions />
        {sections.includes("always-allow-local-commands") && <AlwaysAllowLocalCommands surfaceActive={surfaceActive} />}
      </div>
    );
  }
  return <LocalGeneralPanel surfaceActive={surfaceActive} />;
}

function LocalGeneralPanel({ surfaceActive }: { surfaceActive: boolean }) {
  return (
    <div className="flex flex-col gap-8">
      <SettingsGroup>
        <FollowUpBehaviorSetting />
        <KeepAwakeSetting />
        <ShowHiddenWorkspacesRow />
        <RestartOnUpdateRow />
      </SettingsGroup>
      <ComputerUseSettingsSection surfaceActive={surfaceActive} />
      <PrivacyGroup surfaceActive={surfaceActive} />
    </div>
  );
}

/** The same page under every owner: personal rows, then this Mac's. */
function PersonalGeneralPanel() {
  return (
    <div className="flex flex-col gap-8">
      <SettingsGroup>
        <FollowUpBehaviorSetting />
        <ShowHiddenWorkspacesRow />
      </SettingsGroup>
      <SettingsGroup title={<PlaceLabel place="mac" />}>
        <KeepAwakeSetting />
        <RestartOnUpdateRow />
        <AnalyticsRow />
      </SettingsGroup>
    </div>
  );
}

function ShowHiddenWorkspacesRow() {
  const showHidden = useShowHiddenWorkspaces();
  return (
    <SettingsRow
      label="Show hidden workspaces in dashboard"
      hint="In the Archived list."
    >
      <Switch
        checked={showHidden}
        onCheckedChange={setShowHiddenWorkspaces}
        aria-label="Show hidden workspaces in dashboard"
      />
    </SettingsRow>
  );
}

function RestartOnUpdateRow() {
  const restartAutomatically = useRestartAutomaticallyOnUpdate();
  return (
    <SettingsRow
      label="Restart automatically on update"
      hint="Restarts to install updates after 10 minutes away."
      htmlFor="restart-automatically-on-update"
    >
      <Switch
        id="restart-automatically-on-update"
        checked={restartAutomatically}
        onCheckedChange={setRestartAutomaticallyOnUpdate}
      />
    </SettingsRow>
  );
}

function ComputerUsePanel({ surfaceActive = true }: { surfaceActive?: boolean }) {
  const native = useNativeRuntime().ready;
  return (
    <div className="flex flex-col gap-8">
      <ComputerUseSettingsSection surfaceActive={surfaceActive} device />
      {native && (
        <SettingsGroup title="Privacy">
          <FullDiskAccessRow surfaceActive={surfaceActive} />
          <ComputerPermissionRows surfaceActive={surfaceActive} device />
        </SettingsGroup>
      )}
    </div>
  );
}

function OrganizationGeneralPanel({ surfaceActive = true }: { surfaceActive?: boolean }) {
  const organization = useActiveOrganization();
  const cloudAccess = !!organization && hasCloudWorkspaceAccountAccess(organization.id);
  const sections = unifiedOrganizationGeneralSections(organization, cloudAccess);
  if (!organization) return null;
  return (
    <div className="flex flex-col gap-8">
      {sections.includes("workspace-api-access") && <WorkspaceApiAccessSetting organizationId={organization.id} surfaceActive={surfaceActive} />}
      {sections.includes("always-allow-local-commands") && <AlwaysAllowLocalCommands surfaceActive={surfaceActive} />}
    </div>
  );
}


function SignInMethodRow({
  label,
  desc,
  connected,
}: {
  label: string;
  desc: string;
  connected: boolean;
}) {
  return (
    <SettingsRow label={label} hint={desc}>
      {connected ? (
        <span className="text-green-primary flex shrink-0 items-center gap-1.5 text-xs leading-4.5 font-medium">
          <CircleCheck className="size-3.5" aria-hidden />
          Connected
        </span>
      ) : (
        // Keep this status passive until there is an account-linking flow.
        <span className="text-fg3 shrink-0 text-3xxs leading-4">Not linked</span>
      )}
    </SettingsRow>
  );
}

// useAuth exposes bounded identity and a short-lived bearer, not refresh material.
function AccountPanel() {
  const {
    email,
    session,
    status,
    signOut,
    signOutEverywhere,
    accounts = [],
    switchAccount,
    signOutAccount,
    startBrowserSignIn,
    cancelPendingOAuth,
  } = useAuth();
  const otherAccounts = accounts.filter((account) => !account.active);
  const [accountAction, setAccountAction] = useState<string | null>(null);
  const runAccountAction = async (key: string, action: () => Promise<unknown>) => {
    if (accountAction) return;
    setAccountAction(key);
    try {
      await action();
    } finally {
      setAccountAction(null);
    }
  };
  const handleAddAccount = () => runAccountAction("add", async () => {
    const result = await startBrowserSignIn({ addAccount: true });
    if (!result.ok) toast.error(result.error ?? "Couldn't start sign-in.");
    else toast.info("Continue in your browser to add an account.", {
      action: { label: "Cancel", onClick: cancelPendingOAuth },
    });
  });
  const [signingOut, setSigningOut] = useState(false);
  const [signingOutAll, setSigningOutAll] = useState(false);

  const authed = status === "authenticated" && !!email;
  const primaryProvider = accountAuthenticationProvider(
    session?.user.authenticationMethod,
  );
  const primaryProviderLabel =
    accountAuthenticationProviderLabel(primaryProvider);
  const linked = new Set(primaryProvider ? [primaryProvider] : []);
  const displayName = session?.user.name ?? null;
  const initial = (email?.[0] ?? "?").toUpperCase();

  // No busy-state reset on success: AuthGate unmounts both handlers' panel.
  const handleSignOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    await signOut();
  };

  const handleSignOutEverywhere = async () => {
    if (signingOutAll) return;
    setSigningOutAll(true);
    await signOutEverywhere();
  };

  return (
    <div className="flex flex-col gap-8">
      {authed ? (
        <>
          {/* Use initials so opening Settings never contacts an avatar provider. */}
          <SettingsGroup>
            <div className="flex items-center gap-3">
              <Avatar size="lg" aria-hidden>
                <AvatarFallback>{initial}</AvatarFallback>
              </Avatar>
              <div className="flex min-w-0 flex-col gap-0.5 text-xs leading-4.5">
                {displayName && (
                  <div className="text-fg1 truncate font-medium">
                    {displayName}
                  </div>
                )}
                <div
                  className={cn(
                    "truncate",
                    displayName ? "text-fg2" : "text-fg1 font-medium",
                  )}
                >
                  {email}
                </div>
                {primaryProviderLabel && (
                  <div className="text-fg2">
                    Signed in with {primaryProviderLabel}
                  </div>
                )}
              </div>
            </div>
          </SettingsGroup>

          <SettingsGroup
            title="Sign-in methods"
            description="More providers later."
          >
            <SignInMethodRow
              label="GitHub"
              desc="Sign in with one click."
              connected={linked.has("github")}
            />
            <SignInMethodRow
              label="Google"
              desc="Sign in with one click."
              connected={linked.has("google")}
            />
          </SettingsGroup>

          <SettingsGroup
            title="Accounts on this Mac"
            description="Switch accounts without signing out. Local workspaces stay the same for every account."
          >
            {otherAccounts.map((account) => (
              <SettingsRow
                key={account.accountId}
                label={account.email}
                hint={account.name ?? undefined}
              >
                <div className="flex items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={accountAction === `switch:${account.accountId}`}
                    disabled={accountAction !== null}
                    onClick={() => runAccountAction(`switch:${account.accountId}`, () => switchAccount(account.accountId))}
                  >
                    Switch
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={accountAction === `sign-out:${account.accountId}`}
                    disabled={accountAction !== null}
                    onClick={() => runAccountAction(`sign-out:${account.accountId}`, () => signOutAccount(account.accountId))}
                  >
                    <LogOut size={14} />
                    Sign out
                  </Button>
                </div>
              </SettingsRow>
            ))}
            <SettingsRow
              label="Add account"
              hint="Sign in to another Zeros account in your browser."
            >
              <Button
                variant="secondary"
                size="sm"
                loading={accountAction === "add"}
                disabled={accountAction !== null}
                onClick={handleAddAccount}
              >
                <UserPlus size={14} />
                Add account
              </Button>
            </SettingsRow>
          </SettingsGroup>

          <SettingsGroup title="Sign out">
            <SettingsRow
              label="Sign out"
              hint="Sign out of Zeros on this device."
            >
              <Button
                variant="secondary"
                size="sm"
                loading={signingOut}
                disabled={signingOutAll}
                onClick={handleSignOut}
              >
                <LogOut size={14} />
                Sign out
              </Button>
            </SettingsRow>
            <SettingsRow
              label="Sign out everywhere"
              hint="Signs out every device."
            >
              <Button
                variant="destructive-secondary"
                size="sm"
                loading={signingOutAll}
                disabled={signingOut}
                onClick={handleSignOutEverywhere}
              >
                <LogOut size={14} />
                Sign out everywhere
              </Button>
            </SettingsRow>
          </SettingsGroup>
        </>
      ) : (
        <p className={HINT_CLS}>
          {isLocalDevelopment()
            ? "Zeros Local runs without a Zeros account. Use Zeros Dev to test sign-in."
            : "You're not signed in."}
        </p>
      )}
    </div>
  );
}


// Privacy controls are device-scoped; analytics is metadata-only and macOS owns Full Disk Access.
function PrivacyGroup({ surfaceActive }: { surfaceActive: boolean }) {
  return (
    <SettingsGroup title="Privacy">
      <FullDiskAccessRow surfaceActive={surfaceActive} />
      <ComputerPermissionRows surfaceActive={surfaceActive} />
      <AnalyticsRow />
    </SettingsGroup>
  );
}

function AnalyticsRow() {
  const [optedOut, setOptedOut] = useState<boolean>(() =>
    isAnalyticsOptedOut(),
  );
  const toggle = (enabled: boolean) => {
    setOptedOut(!enabled);
    void setAnalyticsEnabled(enabled);
  };
  return (
    <SettingsRow
      label="Share anonymous usage data"
      hint="Never your code, prompts or keys."
    >
      <Switch
        checked={!optedOut}
        onCheckedChange={toggle}
        aria-label="Share anonymous usage data"
      />
    </SettingsRow>
  );
}

function IntegrationsPanel({ surfaceActive = true, unified = false }: { surfaceActive?: boolean; unified?: boolean }) {
  const organization = useActiveOrganization();
  const { me } = useTeams();
  const organizationId = organization?.isPersonal ? null : organization?.id ?? getActiveOrganizationIdSnapshot();
  if (unified) {
    return <div className="flex flex-col gap-8">
      <GitHubSection surfaceActive={surfaceActive} title={<PlaceLabel place="mac" />} />
      {organizationId && isFeatureEnabled("cloud-workspaces") && me && <CloudGithubSection key={`${me.user.id}:${organizationId}`}
        userId={me.user.id} organizationId={organizationId} surfaceActive={surfaceActive} title={<PlaceLabel place="cloud" />} />}
    </div>;
  }
  return <div className="flex flex-col gap-8">
    {organizationId && isFeatureEnabled("cloud-workspaces") ? me && <CloudGithubSection key={`${me.user.id}:${organizationId}`} userId={me.user.id} organizationId={organizationId} surfaceActive={surfaceActive} />
      : <GitHubSection surfaceActive={surfaceActive} />}
  </div>;
}



const MODELS_SECTION_CLS = SETTINGS_CARD_LIST_CLS;

function ModelsPanel({ surfaceActive = false }: { surfaceActive?: boolean }) {
  const sessions = useAgentSessions();
  const bridgeStatus = useBridgeStatus();
  const [providerSettingsTab, setProviderSettingsTab] = useState<
    "claude" | "codex"
  >("claude");
  const [codexMemoryBusy, setCodexMemoryBusy] = useState(false);
  const [resetMemoryOpen, setResetMemoryOpen] = useState(false);
  const workspaceFolder = useWorkspaceStore(selectActiveFolder);
  const agents = useWorkspaceAgents(workspaceFolder, surfaceActive);
  const { isEnabled } = useEnabledAgents();
  const { agentId: defaultAgentId, setDefault } = useDefaultAgent();

  useEffect(() => {
    if (!surfaceActive) setResetMemoryOpen(false);
  }, [surfaceActive]);

  // Warm the same registry cache the New Chat menu uses.
  const listAgentsRef = useRef(sessions.listAgents);
  useEffect(() => {
    listAgentsRef.current = sessions.listAgents;
  }, [sessions]);
  useEffect(() => {
    if (!surfaceActive || bridgeStatus !== "connected" || isCloudWorkspace(workspaceFolder)) return;
    loadAgents((force) => listAgentsRef.current(force)).catch(() => {
      /* engine respawn / bridge blip — the next connect re-runs */
    });
  }, [bridgeStatus, surfaceActive, workspaceFolder]);

  const codexDiagnosticsActive =
    surfaceActive &&
    providerSettingsTab === "codex" &&
    bridgeStatus === "connected";
  const memoryRead = useRecoveringRead(
    providerMemorySettingsCache,
    codexDiagnosticsActive ? "codex" : null,
    (agentId) => sessions.readMemorySettings(agentId),
    { maxAgeMs: PROVIDER_DIAGNOSTIC_MAX_AGE_MS, connected: bridgeStatus === "connected" },
  );
  const codexMemory = memoryRead.data ?? null;

  // Resolve against the same exact-workspace snapshot as New Chat. Keep a
  // saved disconnected default visible, while only connected choices can pick.
  const effectiveAgentId = pickDefaultAgentId(agents ?? [], defaultAgentId);
  const effectiveAgent = agents?.find(agent => agent.id === effectiveAgentId);
  const modelAgents = (agents ?? [])
    .filter((a) => a.id === effectiveAgentId || (isEnabled(a.id, a.beta) && isSelectableAgent(a)))
    .filter((a) => agentFamily(a.id) !== "")
    .sort((a, b) => a.name.localeCompare(b.name));

  // Read the effective model synchronously from the same atomic selection as
  // the agent. A family switch must never paint one frame with the prior
  // family's model in the new provider's Select.
  useFavoritesVersion();
  const [planDefault, setPlanDefault] = useDefaultPlanMode();
  // Reliability settings are global, but already-loaded Claude chats hold an
  // engine session. Push the same full env encoder those sessions use so a
  // timeout change takes effect now instead of waiting for the next restart.
  const applyClaudeSettings = () => {
    mirrorModelsToSettings();
    for (const chat of useWorkspaceStore.getState().chats) {
      if (agentFamily(chat.agentId) === "claude")
        sessions.updateConfig(chat.id);
    }
  };

  const updateCodexMemory = async (
    settings: Partial<
      Pick<
        AgentMemorySettings,
        "localMemoriesEnabled" | "toolAssistedGenerationEnabled"
      >
    >,
  ) => {
    if (!codexMemory || codexMemoryBusy) return;
    const previous = codexMemory;
    providerMemorySettingsCache.setData("codex", {
      ...codexMemory,
      ...settings,
    });
    setCodexMemoryBusy(true);
    try {
      providerMemorySettingsCache.setData(
        "codex",
        await sessions.updateMemorySettings("codex", settings),
      );
    } catch (error) {
      providerMemorySettingsCache.setData("codex", previous);
      toast.error("Couldn't update Codex memory", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setCodexMemoryBusy(false);
    }
  };

  const deleteCodexMemories = async () => {
    if (codexMemoryBusy) return;
    setCodexMemoryBusy(true);
    try {
      await sessions.resetMemory("codex");
      setResetMemoryOpen(false);
    } catch (error) {
      toast.error("Couldn't delete Codex memories", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setCodexMemoryBusy(false);
    }
  };
  const agentModels = effectiveAgentId
    ? modelsForAgent(effectiveAgentId, null)
    : [];
  const favorite = effectiveFavoriteModel(effectiveAgentId);
  const currentModel = getFavoriteModel(effectiveAgentId) ? favorite
    : modelForNewChat(effectiveAgentId) ?? favorite ?? agentModels[0]?.value ?? null;
  const currentModelLabel = currentModel
    ? displayModelLabel(
        effectiveAgentId,
        agentModels.find((m) => m.value === currentModel)?.label ??
          currentModel,
      )
    : null;

  const pickAgent = (agentId: string) => {
    if (!agentId) return;
    setDefault(agentId);
    // setDefault updates the cache; this mirror persists the choice in user settings.toml.
    mirrorModelsToSettings();
  };

  return (
    <div className="flex flex-col gap-4">
      <SettingsList className={MODELS_SECTION_CLS}>
        <SettingsRow label="Default agent" hint="Agent for new chats">
          <div className="flex items-center gap-2">
            <Select value={effectiveAgentId ?? ""} onValueChange={pickAgent}>
              <SelectTrigger width="fixed" aria-label="Default agent" data-default-agent-picker>
                <SelectValue placeholder="Select an agent">{effectiveAgent?.name}</SelectValue>
              </SelectTrigger>
              <SelectContent className="min-w-[180px]">
                {modelAgents.length === 0 ? (
                  <div className="text-fg2 px-2 py-1.5 text-xs">
                    No agents available.
                  </div>
                ) : (
                  modelAgents.map((a) => (
                    <SelectItem key={a.id} value={a.id} disabled={!isEnabled(a.id, a.beta) || !isSelectableAgent(a)}>
                      {a.name}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
            {/* Set per-model Effort and Fast in the composer's model menu, not on the global favorite. */}
            {effectiveAgentId && currentModel && (
              <Select
                value={currentModel}
                onValueChange={(model) =>
                  starFavoriteModel(effectiveAgentId, model)
                }
              >
                <SelectTrigger width="fixed" aria-label="Default model" data-default-model-picker>
                  <SelectValue>{currentModelLabel}</SelectValue>
                </SelectTrigger>
                <SelectContent className="min-w-[180px]">
                  {agentModels.map((model) => (
                    <SelectItem key={model.value} value={model.value}>
                      {displayModelLabel(effectiveAgentId, model.label)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        </SettingsRow>
        <SettingsRow
          label="Chat titles"
          hint="Sends your first 500 characters to OpenAI"
        >
          <span className="text-fg2 text-xs">Automatic</span>
        </SettingsRow>
      </SettingsList>

      <SettingsList className={MODELS_SECTION_CLS}>
        <SettingsRow
          label="Default to plan mode"
          hint="Start new chats in plan mode"
        >
          <Switch
            checked={planDefault}
            onCheckedChange={setPlanDefault}
            aria-label="Default to plan mode"
          />
        </SettingsRow>
      </SettingsList>

      <SettingsSection title="Provider settings">
        <Tabs
          value={providerSettingsTab}
          onValueChange={(value) =>
            setProviderSettingsTab(value as "claude" | "codex")
          }
        >
          <TabsList aria-label="Provider settings" className="mb-2">
            <TabsTrigger value="claude">Claude</TabsTrigger>
            <TabsTrigger value="codex">Codex</TabsTrigger>
          </TabsList>
          <TabsContent value="claude" className="mt-0">
            <SettingsList className={MODELS_SECTION_CLS}>
              <ClaudeProviderSettings onChange={applyClaudeSettings} />
            </SettingsList>
          </TabsContent>
          <TabsContent value="codex" className="mt-0">
            <p className="text-fg3 mt-0 mb-2 text-3xxs leading-4">
              These also change Codex outside Zeros.
            </p>
            <SettingsList className={MODELS_SECTION_CLS}>
              {memoryRead.error && (
                <SettingsRow label="Couldn't read memory settings">
                  <Button variant="ghost" size="sm" onClick={memoryRead.refresh}>
                    Retry
                  </Button>
                </SettingsRow>
              )}
              <SettingsRow
                label="Local memories"
                hint="Learns project context on this device"
              >
                <Switch
                  checked={codexMemory?.localMemoriesEnabled ?? false}
                  disabled={
                    bridgeStatus !== "connected" ||
                    !codexMemory ||
                    codexMemoryBusy
                  }
                  onCheckedChange={(enabled) =>
                    void updateCodexMemory({ localMemoriesEnabled: enabled })
                  }
                  aria-label="Codex local memories"
                />
              </SettingsRow>
              <SettingsRow
                label="Learn from tool-assisted chats"
                hint="Chats that use tools add memories"
              >
                <Switch
                  checked={codexMemory?.toolAssistedGenerationEnabled ?? false}
                  disabled={
                    bridgeStatus !== "connected" ||
                    !codexMemory ||
                    !codexMemory.localMemoriesEnabled ||
                    codexMemoryBusy
                  }
                  onCheckedChange={(enabled) =>
                    void updateCodexMemory({
                      toolAssistedGenerationEnabled: enabled,
                    })
                  }
                  aria-label="Codex tool-assisted memory generation"
                />
              </SettingsRow>
              <SettingsRow
                label="Delete local memories"
                hint="Removes Codex’s local memories"
              >
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={
                    bridgeStatus !== "connected" ||
                    !codexMemory?.canReset ||
                    codexMemoryBusy
                  }
                  onClick={() => setResetMemoryOpen(true)}
                >
                  <Trash2 className="size-3.5" />
                  Delete
                </Button>
              </SettingsRow>
            </SettingsList>
          </TabsContent>
        </Tabs>
      </SettingsSection>

      <Dialog
        open={retainedDialogOpen(surfaceActive, resetMemoryOpen)}
        onOpenChange={setResetMemoryOpen}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Codex memories?</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <DialogDescription>Your Zeros chats aren’t affected.</DialogDescription>
          </DialogBody>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setResetMemoryOpen(false)}
              disabled={codexMemoryBusy}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              loading={codexMemoryBusy}
              onClick={() => void deleteCodexMemories()}
            >
              Delete memories
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// Branch naming is personal; remote and base branch belong to the repository.
function GitDefaultsPanel() {
  return (
    <div className="flex flex-col gap-9">
      <GitDefaultsSection />
    </div>
  );
}

function TerminalAgentsPanel() {
  return <TerminalAgentsSection />;
}

function ExperimentalPanel() {
  const [terminalAgents, setTerminalAgents] =
    useExperimentalFeature("terminalAgents");
  const [hideArchived, setHideArchived] = useExperimentalFeature(
    "hideArchivedWorkspacesAfter15Days",
  );
  const [gibberishThinking, setGibberishThinking] = useExperimentalFeature("gibberishAgentThinking");
  return (
    <div className="flex flex-col gap-8">
      <p className={HINT_CLS}>Still in development; may change.</p>
      <SettingsGroup>
        <SettingsRow
          label="Terminal Agents"
          hint="Set up coding CLIs for the terminal."
        >
          <Switch
            checked={terminalAgents}
            onCheckedChange={setTerminalAgents}
            aria-label="Show the Terminal Agents tab"
          />
        </SettingsRow>
        <SettingsRow
          label="Hide archived workspaces after 15 days"
          hint="After 15 days. Chats and snapshots stay."
        >
          <Switch
            checked={hideArchived}
            onCheckedChange={setHideArchived}
            aria-label="Hide archived workspaces after 15 days"
          />
        </SettingsRow>
        <SettingsRow
          label="Gibberish agent thinking"
          hint="A playful word beside the timer while the agent works."
        >
          <Switch
            checked={gibberishThinking}
            onCheckedChange={setGibberishThinking}
            aria-label="Show gibberish agent thinking"
          />
        </SettingsRow>
        {agentControlFeaturesAt("experimental").map((feature) => (
          <ExperimentalAgentControlRow key={feature} feature={feature} />
        ))}
      </SettingsGroup>
    </div>
  );
}

function ExperimentalAgentControlRow({
  feature,
}: {
  feature: AgentControlFeature;
}) {
  const [on, setOn] = useExperimentalFeature(feature);
  const row = AGENT_CONTROL_FEATURE_ROWS[feature];
  return (
    <SettingsRow label={row.label} hint={row.hint}>
      <Switch checked={on} onCheckedChange={setOn} aria-label={row.label} />
    </SettingsRow>
  );
}

function InternalAgentControlRow({ feature }: { feature: AgentControlFeature }) {
  const [on, setOn] = useInternalFeature(feature);
  const row = AGENT_CONTROL_FEATURE_ROWS[feature];
  return (
    <SettingsRow label={row.label} hint={row.hint}>
      <Switch checked={on} onCheckedChange={setOn} aria-label={row.label} />
    </SettingsRow>
  );
}

// Internal flags are staff-gated and stored separately by app channel.
function InternalPanel() {
  const [copyLogs, setCopyLogs] = useInternalFeature("copyLogs");
  const [resourceSummary, setResourceSummary] = useInternalFeature("resourceSummary");
  const [designGpuCanvas, setDesignGpuCanvas] = useInternalFeature("designGpuCanvas");
  const [releaseCandidates, setReleaseCandidates] = useInternalFeature("releaseCandidates");
  const agentControlFeatures = agentControlFeaturesAt("internal");
  return (
    <div className="flex flex-col gap-8">
      <SettingsGroup>
        <SettingsRow
          label="Copy logs"
          hint="⇧⌘L copies recent app logs to the clipboard."
        >
          <Switch
            checked={copyLogs}
            onCheckedChange={setCopyLogs}
            aria-label="Enable the copy-logs shortcut"
          />
        </SettingsRow>
        <SettingsRow
          label="Resource summary"
          hint="Show live app memory in the sidebar and inspect resource usage."
        >
          <Switch
            checked={resourceSummary}
            onCheckedChange={setResourceSummary}
            aria-label="Show resource summary"
          />
        </SettingsRow>
        <SettingsRow
          label="Recorded Design canvas"
          hint="Draw Local Design frames from recorded pictures on the GPU."
        >
          <Switch
            checked={designGpuCanvas}
            onCheckedChange={setDesignGpuCanvas}
            aria-label="Draw Design frames from recordings"
          />
        </SettingsRow>
        {CHANNEL === "stable" ? (
          <SettingsRow
            label="Release candidates"
            hint="Update this app to each release before it reaches everyone. Turning this off keeps the current version until a newer release."
          >
            <Switch
              checked={releaseCandidates}
              onCheckedChange={setReleaseCandidates}
              aria-label="Receive release candidates"
            />
          </SettingsRow>
        ) : null}
      </SettingsGroup>
      {agentControlFeatures.length > 0 ? (
        <SettingsGroup title="Agent control">
          {agentControlFeatures.map((feature) => (
            <InternalAgentControlRow key={feature} feature={feature} />
          ))}
        </SettingsGroup>
      ) : null}
    </div>
  );
}


const THEME_OPTIONS: Array<{ value: ThemeMode; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

function AppearancePanel() {
  const { prefs, setPrefs } = useAppearance();
  // Match code themes to the active background; each variant remembers its own choice.
  const variant = useThemeVariant();
  const codeThemes = codeThemesForVariant(variant);

  return (
    <div className="flex flex-col gap-8">
      <SettingsGroup>
        <SettingsRow
          label="Theme"
          hint="System follows macOS."
        >
          <Select
            value={prefs.mode}
            onValueChange={(v) => setPrefs({ mode: v as ThemeMode })}
          >
            <SelectTrigger width="fixed">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {THEME_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow
          label="Chat width"
          hint="How wide conversations grow in a wide pane."
        >
          <Select
            value={prefs.chatWidth}
            onValueChange={(v) => setPrefs({ chatWidth: v as ChatWidth })}
          >
            <SelectTrigger width="fixed" aria-label="Chat width">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CHAT_WIDTH_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Code">
        <SettingsRow
          label="Code theme"
          hint="For code, diffs and the terminal."
        >
          <Select
            value={prefs.codeTheme}
            onValueChange={(v) => setPrefs({ codeTheme: v })}
          >
            <SelectTrigger width="fixed">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {codeThemes.map((opt) => (
                <SelectItem key={opt.id} value={opt.id}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
        <div>
          <CodeThemePreview />
        </div>
      </SettingsGroup>
    </div>
  );
}
