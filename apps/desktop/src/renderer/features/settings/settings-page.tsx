import { isSettingsSectionAvailable } from "./settings-section-availability";
import { CloudComputerPanel, prefetchCloudComputer } from "./cloud-computer-panel";
import { CloudGithubSection } from "./cloud-github-section";
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
  GitPullRequest,
  FlaskConical,
  CircleUser,
  CircleCheck,
  LogOut,
  Lock,
  Globe2,
  MousePointerClick,
  Smartphone,
  Trash2,
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
import { Button } from "../../shared/ui";
import { isLocalDevelopment } from "../../platform/runtime";
import { toast } from "@/renderer/shared/ui/primitives/elements";
import { cn } from "@/renderer/shared/ui/cn";
import { Switch } from "../../shared/ui/primitives/switch";
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
import { type ThemeMode } from "../../shared/theme/prefs";
import { codeThemesForVariant } from "../../shared/theme/code-themes";
import { useThemeVariant } from "../../shared/theme/use-theme-variant";
import { CodeThemePreview } from "./code-theme-preview";
import { useOrganizationProjects } from "../../state/use-organization-projects";
import { ProvidersPanel } from "./providers-panel";
import { BrowserUsePanel } from "./browser-use-panel";
import { ComputerUsePanel } from "./computer-use-panel";
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
  UserEnvironmentPanel,
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
import { isFeatureEnabled } from "../../config/release-channel";
import { CloudWorkspacePausedNotice } from "../team/cloud-workspace-pause";
type SectionId =
  | "general"
  | "appearance"
  | "models"
  | "providers"
  | "browser-use"
  | "computer-use"
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

type SectionDef = {
  id: SectionId;
  label: string;
  icon: LucideIcon;
  /** Optional per-row nav override, appended AFTER `SIDEBAR_ENTRY_CLS` so
   *  twMerge lets it win (see `INTERNAL_NAV_CLS`). */
  navClassName?: string;
  Panel: ComponentType<{ surfaceActive?: boolean }>;
};

// Internal's row is the one colored entry: label and icon carry
// `--brown-primary` in every state. Declared above SECTIONS, which evaluates at
// module load. It restates every state SIDEBAR_ENTRY_CLS paints because twMerge
// keeps the last class per group and modifier; a missed state falls back.
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
    id: "computer-use",
    label: "Computer use",
    icon: MousePointerClick,
    Panel: ComputerUsePanel,
  },
  {
    id: "simulators",
    label: "Simulators",
    icon: Smartphone,
    Panel: SimulatorsPanel,
  },
  // Gated by the `terminalAgents` experimental flag — hidden from the
  // sidebar (and not resolvable as an active section) until the user
  // opts in from Settings → Experimental. See `availableSections`.
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
    Panel: UserEnvironmentPanel,
  },
  {
    id: "git",
    label: "Git & PR",
    icon: GitPullRequest,
    Panel: GitDefaultsPanel,
  },
  // MCP servers live on Customize and repository settings on each repository
  // page. A stale `user:mcp` redirects to Customize; "repos" stays in SectionId
  // only so legacy `repo:<id>:<section>` selections parse and redirect.
  {
    id: "integrations",
    label: "Integrations",
    icon: Blocks,
    Panel: IntegrationsPanel,
  },
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
  // Gated to developer accounts (`users.staff_role`, served by GET /v1/me — see
  // settings/internal-features.ts) — hidden from the sidebar AND not
  // resolvable as an active section for everyone else. See
  // `availableSections`.
  {
    id: "internal",
    label: "Internal",
    icon: Lock,
    navClassName: INTERNAL_NAV_CLS,
    Panel: InternalPanel,
  },
];

// Labelled nav groups, in order. A section gated off in `availableSections`
// drops out of its group.
const SECTION_GROUPS: Array<{ label: string; ids: SectionId[] }> = [
  {
    label: "Personal",
    ids: [
      "general",
      "appearance",
      "experimental",
      "account",
      "integrations",
      "internal",
    ],
  },
  {
    label: "Agents",
    ids: ["models", "providers", "browser-use", "computer-use", "simulators", "terminal-agents"],
  },
  { label: "Workspace", ids: ["cloud-computer", "environment", "git"] },
];

// One persisted string encodes the selection: `user:<sectionId>`, or a legacy
// `repo:<projectId>:<repoSection>` that redirects to the repository page. Bare
// legacy values map forward on read. Section ids are independent of nav labels,
// so persisted values and deep links survive renames.

/** The repo drill-in's landing page (the card list), a
 *  pseudo-section alongside the real repo sections. */
const REPO_OVERVIEW = "overview" as const;

type RepoPage = RepoSectionId | typeof REPO_OVERVIEW;

type Selection =
  | { scope: "user"; section: SectionId }
  | { scope: "repo"; repoId: string; section: RepoPage };

function userSelection(section: SectionId): string {
  return `user:${section}`;
}

function repoSelection(repoId: string, section: RepoPage): string {
  return `repo:${repoId}:${section}`;
}

function isRepoPage(value: string): value is RepoPage {
  return value === REPO_OVERVIEW || isRepoSectionId(value);
}

function isStaticSection(value: string): value is SectionId {
  return (VALID_STATIC_SECTIONS as readonly string[]).includes(value);
}

/** Decode the persisted active string into a structured selection,
 *  tolerating the legacy bare-section / `repo:<id>` shapes. */
function parseSelection(active: string): Selection {
  if (active.startsWith("repo:")) {
    const rest = active.slice("repo:".length);
    // The pre-revamp empty sentinel (`repo:` with no id) → the Repos list.
    if (!rest) return { scope: "user", section: "repos" };
    const lastColon = rest.lastIndexOf(":");
    if (lastColon > 0) {
      const raw = rest.slice(lastColon + 1);
      // Legacy persisted ids still parse as a repo selection so the redirect
      // effect lands them on the repo page: the former Scripts / run-actions
      // views folded into Environment; MCP left the repo sections entirely
      // (2026-07-17). Retired Design settings also land on Environment.
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
    // Legacy `repo:<id>` (no section) → the repo's overview page.
    return { scope: "repo", repoId: rest, section: REPO_OVERVIEW };
  }
  const rawBare = active.startsWith("user:")
    ? active.slice("user:".length)
    : active;
  // Organization/Team administration moved to app.zeros.build. Old persisted
  // selections resolve to General instead of exposing a retired desktop panel.
  const bare =
    rawBare === "organization" || rawBare === "team" || rawBare === "members"
      ? "general"
      : rawBare;
  return { scope: "user", section: isStaticSection(bare) ? bare : "general" };
}

const PAGE_HEADING_CLS = "m-0 text-lg font-medium leading-tight text-fg1";

const HINT_CLS = "text-sm text-fg2";

// Derived from SECTIONS so a newly-registered section is automatically a
// valid persisted target. A hardcoded list silently dropped any new section:
// parseSelection rejected its id and fell back to "general", so the sidebar
// entry rendered but clicking it never opened the panel.
const VALID_STATIC_SECTIONS: SectionId[] = SECTIONS.map((s) => s.id);

// Comment-only seed written to ~/.zeros/settings.toml on first "Open …" click
// so Finder has a file to select (hand-edits happen in your own editor).
const USER_SETTINGS_SEED = `# Zeros user settings (this Mac).
# Values you set in Settings are saved here.
`;

function loadInitialSection(owner: string): string {
  // Normalize to the canonical encoding so legacy values (bare `general`,
  // `repo:<id>` without a section) migrate forward on first read. A
  // `repo:<id>:<section>` value passes through; its repo id is re-validated
  // against the project list in the mount-time effect once projects hydrate.
  const sel = parseSelection(
    readScopedSettingsSelection(owner, "section", owner === "local" ? "user:general" : "user:providers"),
  );
  return sel.scope === "user"
    ? userSelection(sel.section)
    : repoSelection(sel.repoId, sel.section);
}

// Shared by static sections and per-repo rows. Selection is color only (fg2 →
// fg1 plus the lifted background), so rows keep their width. `hover:text-fg2`
// cancels the ghost Button's `hover:text-fg1` (twMerge keeps the later class).
// Icons are sized by `[&_svg]:size-3.5`, the primitive's own selector, because
// CSS size beats the attributes lucide's `size` prop emits.
const SIDEBAR_ENTRY_CLS =
  "flex h-auto w-full min-w-0 items-center justify-start gap-2.5 rounded-md border-0 bg-transparent px-2.5 py-1.5 text-left text-sm font-normal text-fg2 transition-colors duration-150 ease-out hover:bg-sidebar-bg-hover hover:text-fg2 data-[state=active]:bg-sidebar-bg-hover data-[state=active]:text-fg1 data-[state=active]:hover:text-fg1 [&_svg]:size-3.5 [&>svg]:shrink-0 [&>svg]:text-fg2 data-[state=active]:[&>svg]:text-fg1";

const SETTINGS_GROUP_HEADER_CLS =
  "select-none px-2.5 pb-1.5 pt-5 text-xs font-normal text-muted-fg";

export function SettingsPage() {
  const organization = useActiveOrganization();
  const { me } = useTeams();
  const organizationId = organization?.isPersonal ? null : organization?.id ?? getActiveOrganizationIdSnapshot();
  const owner = settingsOwnerKey(me?.user.id ?? "pending", organizationId);
  // Switch the complete form tree in the same render as its owner. Retained
  // sections, dialogs, secrets and unsaved drafts must never cross this boundary.
  return <ScopedSettingsPage key={owner} owner={owner} />;
}

function ScopedSettingsPage({ owner }: { owner: string }) {
  const local = owner === "local";
  const cloudEnabled = isFeatureEnabled("cloud-workspaces");
  const organization = useActiveOrganization();
  const { me } = useTeams();
  const pageSurfaceRef = useRef<HTMLDivElement | null>(null);
  const dispatch = useWorkspaceDispatch();
  const pageActive = useActivePage() === "settings";
  const { projects } = useOrganizationProjects();
  // Restored from native settings. Type-guarded so a renamed section cannot crash
  // mount; repo ids are re-validated once `projects` hydrates.
  const [active, setActiveState] = useState<string>(() => loadInitialSection(owner));
  const setActive = useCallback((next: string) => {
    setActiveState(next);
    writeScopedSettingsSelection(owner, "section", next);
  }, [owner]);
  const selection = parseSelection(active);
  useInstantViewSwitch(`settings:${owner}:${active}`, pageSurfaceRef);

  // Deep links from action-error toasts must update this retained page as well
  // as persistence; otherwise reopening an already-mounted Settings surface
  // would show its stale prior section.
  useEffect(
    () =>
      subscribeUserSettingsSection((section) => {
        if (isStaticSection(section)) {
          setActiveState(userSelection(section));
        }
      }, owner),
    [owner],
  );

  // Invite handoff remains desktop-readable for existing email links; all
  // member management and organization creation live in the web dashboard.
  const [joinTeamOpen, setJoinTeamOpen] = useState(false);
  const [joinToken, setJoinToken] = useState("");

  // A zeros://invite deep link opens the Join dialog pre-filled — on cold
  // navigation (token captured before this mount) and while Settings is
  // already open. Works in every team state, including zero teams.
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

  // One-time import of the legacy localStorage
  // settings blobs into the engine-owned TOML files. Flag-guarded + merge-under
  // on the engine side, so calling on every settings open is safe.
  const bridge = useBridge();
  useEffect(() => {
    if (local) void ensureSettingsTomlMigrated(bridge);
  }, [bridge, local]);

  // Repository settings moved to the repository page, so a `repo:<id>:<section>`
  // selection re-routes there and Settings resets to its first section. Wait for
  // a non-empty project list: the async fetch must not eat a restored selection
  // before the redirect can resolve it.
  const prevProjectsLenRef = useRef(projects.length);
  useEffect(() => {
    const prevLen = prevProjectsLenRef.current;
    prevProjectsLenRef.current = projects.length;
    const sel = parseSelection(active);
    if (sel.scope !== "repo" || !local) return;
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
  }, [projects, active, dispatch, local, setActive]);

  // A persisted or deep-linked `user:mcp` (or bare `mcp`) re-routes to Customize
  // and resets Settings. This checks the raw string, because parseSelection
  // already maps the unknown id to "general".
  useEffect(() => {
    const bare = active.startsWith("user:")
      ? active.slice("user:".length)
      : active;
    if (bare !== "mcp") return;
    setActive(userSelection("general"));
    dispatch({ type: "SET_ACTIVE_PAGE", page: "customize" });
    // setActive is stable for the component's lifetime (state setter + setSetting).
  }, [active, dispatch, setActive]);
  // Gated sections (Terminal Agents behind its experimental flag, Internal for
  // allowlisted accounts) drop out of `availableSections`, so a stale or forged
  // selection falls back to the first section and signing out never leaves a
  // gated panel reachable.
  const [terminalAgentsEnabled] = useExperimentalFeature("terminalAgents");
  const internalUser = useIsInternalUser();
  // Agent control rollout (agent-control-rollout.ts): a closed feature has
  // no Settings page.
  const computerUseActive = useAgentControlFeatureActive("computerUse");
  const simulatorsActive = useAgentControlFeatureActive("simulators");
  const availableSections = useMemo(
    () =>
      SECTIONS.filter((section) => isSettingsSectionAvailable(section.id, {
        local, cloudEnabled, terminalAgentsEnabled, computerUseActive,
        simulatorsActive, internalUser,
      })),
    [terminalAgentsEnabled, internalUser, local, cloudEnabled, computerUseActive, simulatorsActive],
  );
  const activeSection: SectionDef | null =
    selection.scope === "user"
      ? (availableSections.find((s) => s.id === selection.section) ??
        availableSections[0])
      : local ? null : availableSections[0];
  // Rewrite a selection whose gate just closed; otherwise no row is active and the
  // retired selection reactivates if the gate reopens.
  useEffect(() => {
    if (selection.scope !== "user" && local) return;
    if (selection.scope === "user" && availableSections.some((s) => s.id === selection.section)) return;
    const fallback = availableSections[0]?.id;
    if (fallback) setActive(userSelection(fallback));
    // setActive is stable for the component's lifetime (state setter + setSetting).
  }, [availableSections, selection.scope, selection.section, local, setActive]);
  // Visited form panels remain mounted so local drafts, scroll-adjacent DOM,
  // provider state, and resolved settings do not restart on every sidebar click.
  const availableSectionIds = useMemo(
    () => new Set(availableSections.map((section) => section.id)),
    [availableSections],
  );
  const sectionIdsToRender = useRetainedViewKeys(
    activeSection?.id ?? null,
    availableSections.length,
    availableSectionIds,
  );

  // Inactive panels hide with display:none in one shared scroller, so a switch
  // clamps scrollTop. Keyed memory gives each section its own offset.
  const detailScrollRef = useScrollMemoryRef(
    activeSection ? `settings:${owner}:${activeSection.id}` : null,
  );

  const handleBack = () => {
    dispatch({ type: "SET_ACTIVE_PAGE", page: "dashboard" });
  };

  // File-scope control — "Open settings.toml" reveals the user file in Finder
  // (the same affordance as the repo page). Floats at the content's top-right.
  // Self-hides when the native Finder integration is unavailable.
  const fileScopeControls = local ? (
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
              className="text-fg2 hover:bg-sidebar-bg-hover hover:text-fg1"
              onClick={handleBack}
            >
              <ArrowLeft strokeWidth={1.5} />
              <span>Back</span>
            </Button>
          </div>
          <nav
            className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pt-4 pb-2"
            role="tablist"
            aria-label="Settings sections"
          >
            <OrganizationSwitcher />
            {SECTION_GROUPS.map((group, groupIndex) => {
              const sections = group.ids.flatMap((id) => {
                const section = availableSections.find((s) => s.id === id);
                return section ? [section] : [];
              });
              if (sections.length === 0) return null;
              return (
                <React.Fragment key={group.label}>
                  <div
                    className={cn(
                      SETTINGS_GROUP_HEADER_CLS,
                      groupIndex === 0 && "pt-1",
                    )}
                  >
                    {group.label === "Personal" ? local ? "Local" : "Organization" : group.label}
                  </div>
                  <div className="flex flex-col gap-1">
                    {sections.map((section) => (
                      <SectionNavButton
                        key={section.id}
                        icon={section.icon}
                        label={section.label}
                        className={section.navClassName}
                        isActive={
                          selection.scope === "user" &&
                          selection.section === section.id
                        }
                        onClick={() => setActive(userSelection(section.id))}
                        onIntent={
                          section.id === "integrations"
                            ? prefetchGithubAuthSnapshot
                            : section.id === "cloud-computer" && organization && me
                              ? () => prefetchCloudComputer(me.user.id, organization)
                            : undefined
                        }
                      />
                    ))}
                  </div>
                </React.Fragment>
              );
            })}
          </nav>
        </div>

        {/* Native overflow, because macOS overlay scrollbars auto-hide. */}
        <div className="border-border1 bg-bg1 relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border-l">
          {/* "Open settings.toml" floats at the top right, mirroring the repo
              page — a transparent drag strip; the button opts out of drag. */}
          <div
            className="flex shrink-0 items-center justify-end px-6 pt-4"
            data-tauri-drag-region
          >
            {fileScopeControls}
          </div>
          {/* The 24px side gutter lives on the SCROLLER, not the column, so
              the column's 680px max is the content width (no inner padding
              eating into it) and it still shrinks below 728px windows. */}
          <div
            ref={detailScrollRef}
            className="min-h-0 flex-1 overflow-y-auto px-6"
          >
            {/* `settings-type-scale` (settings-page.css) sets names to 14px and everything
                else to 13px; names carry `text-[14px]` to opt out of the shrink. */}
            <div
              {...popoverBoundaryProps}
              className="settings-type-scale mx-auto w-full max-w-[680px] pt-10 pb-16"
            >
              {/* A transient repo-scope selection (legacy deep link) renders
                  nothing for one frame — the redirect effect above re-routes
                  it to the repo page. */}
              {sectionIdsToRender.map((sectionId) => {
                const section = availableSections.find(
                  (candidate) => candidate.id === sectionId,
                );
                if (!section) return null;
                const isActive =
                  selection.scope === "user" &&
                  activeSection?.id === section.id;
                const Panel = section.Panel;
                return (
                  <div
                    key={section.id}
                    {...(!isActive ? { inert: "" } : {})}
                    className={isActive ? "flex flex-col gap-6" : "hidden"}
                    aria-hidden={!isActive}
                  >
                    <h1 className={PAGE_HEADING_CLS}>{section.label}</h1>
                    {!local && !cloudEnabled && <CloudWorkspacePausedNotice />}
                    <Panel surfaceActive={pageActive && isActive} />
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Compatibility invite handoff. New invitations are managed on web. */}
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
}: {
  icon: LucideIcon;
  label: string;
  isActive: boolean;
  /** Per-row override, merged AFTER the shared entry class so it wins. */
  className?: string;
  onClick: () => void;
  onIntent?: () => void;
}) {
  return (
    <Button
      variant="ghost"
      role="tab"
      aria-selected={isActive}
      data-state={isActive ? "active" : "inactive"}
      className={cn(SIDEBAR_ENTRY_CLS, className)}
      onClick={onClick}
      // Called, never forwarded bare: React hands a handler the synthetic
      // event, which `prefetchGithubAuthSnapshot` would take as its `fetcher`.
      // `KeyedAsyncCache.load` then runs `.then(<event>)`, which resolves
      // `undefined` — the prefetch silently does nothing AND publishes that
      // `undefined` over a confirmed snapshot. `onIntent` is declared
      // zero-argument; this is what honours it.
      onPointerEnter={() => onIntent?.()}
      onFocus={() => onIntent?.()}
    >
      <Icon size={14} />
      <span className="truncate">{label}</span>
    </Button>
  );
}

function GeneralPanel({ surfaceActive = true }: { surfaceActive?: boolean }) {
  const showHidden = useShowHiddenWorkspaces();
  const restartAutomatically = useRestartAutomaticallyOnUpdate();
  return (
    <div className="flex flex-col gap-6">
      <SettingsGroup>
        <FollowUpBehaviorSetting />
        <KeepAwakeSetting />
        <SettingsRow
          label="Show hidden workspaces in dashboard"
          hint="Includes hidden workspaces in the Archived list."
        >
          <Switch
            checked={showHidden}
            onCheckedChange={setShowHiddenWorkspaces}
            aria-label="Show hidden workspaces in dashboard"
          />
        </SettingsRow>
        <SettingsRow
          label="Restart automatically on update"
          hint="Automatically restart Zeros when idle to install downloaded updates."
          htmlFor="restart-automatically-on-update"
        >
          <Switch
            id="restart-automatically-on-update"
            checked={restartAutomatically}
            onCheckedChange={setRestartAutomaticallyOnUpdate}
          />
        </SettingsRow>
      </SettingsGroup>
      <PrivacyGroup surfaceActive={surfaceActive} />
    </div>
  );
}

// The renderer sees bounded identity metadata and a short-lived bearer from
// useAuth(), never refresh material.

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
        <span className="text-green-primary flex shrink-0 items-center gap-1.5 text-xs font-medium">
          <CircleCheck className="size-3.5" />
          Connected
        </span>
      ) : (
        // Linking isn't implemented yet (no linkIdentity flow), so we show a
        // plain status label rather than an inert, permanently-disabled
        // "Connect" button that implies an action the user can't take.
        <span className="text-muted-fg shrink-0 text-xs">Not linked</span>
      )}
    </SettingsRow>
  );
}

function AccountPanel() {
  const { email, session, status, signOut, signOutEverywhere } = useAuth();
  const [signingOut, setSigningOut] = useState(false);
  const [signingOutAll, setSigningOutAll] = useState(false);

  const authed = status === "authenticated" && !!email;
  const primaryProvider = accountAuthenticationProvider(
    session?.user.authenticationMethod,
    session?.user.sub,
  );
  const primaryProviderLabel =
    accountAuthenticationProviderLabel(primaryProvider);
  const linked = new Set(primaryProvider ? [primaryProvider] : []);
  const displayName = session?.user.name ?? null;
  const initial = (email?.[0] ?? "?").toUpperCase();

  const handleSignOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    await signOut();
    // The AuthGate flips to the login screen and unmounts this view.
  };

  const handleSignOutEverywhere = async () => {
    if (signingOutAll) return;
    setSigningOutAll(true);
    await signOutEverywhere();
    // The AuthGate flips to the login screen and unmounts this view.
  };

  return (
    <div className="flex flex-col gap-6">
      {authed ? (
        <>
          {/* Identity card. Initials only: we don't load remote provider
              avatars (web CSP blocks them; fetching leaks the user's IP to
              Google/GitHub on every Settings open). */}
          <SettingsGroup>
            <div className="flex items-center gap-3">
              <div className="bg-bg2-hover text-fg1 flex size-10 shrink-0 items-center justify-center rounded-full text-sm font-medium">
                {initial}
              </div>
              <div className="flex min-w-0 flex-col gap-0.5">
                {displayName && (
                  <div className="text-fg1 truncate text-[13px] font-medium">
                    {displayName}
                  </div>
                )}
                <div
                  className={cn(
                    "truncate text-[13px]",
                    displayName ? "text-fg2" : "text-fg1 font-medium",
                  )}
                >
                  {email}
                </div>
                {primaryProviderLabel && (
                  <div className="text-fg2 text-[13px]">
                    Signed in with {primaryProviderLabel}
                  </div>
                )}
              </div>
            </div>
          </SettingsGroup>

          <SettingsGroup
            title="Sign-in methods"
            description="Linking a second provider arrives in a later update."
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
              hint="Revoke every active session on all devices."
            >
              {/* Cautionary (destructive-tinted) styling so this global,
                  hard-to-undo action reads differently from the routine
                  this-device "Sign out" directly above it. */}
              <Button
                variant="secondary"
                size="sm"
                loading={signingOutAll}
                disabled={signingOut}
                onClick={handleSignOutEverywhere}
                className="border-red-primary/40 text-red-primary hover:bg-red-primary/10 hover:text-red-primary"
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

// Both controls belong to this device, independently of sign-in. Analytics
// remains opt-out and metadata-only; macOS owns the Full Disk Access grant.

function PrivacyGroup({ surfaceActive }: { surfaceActive: boolean }) {
  const [optedOut, setOptedOut] = useState<boolean>(() =>
    isAnalyticsOptedOut(),
  );
  const toggle = (enabled: boolean) => {
    setOptedOut(!enabled);
    void setAnalyticsEnabled(enabled);
  };

  return (
    <SettingsGroup title="Privacy">
      <FullDiskAccessRow surfaceActive={surfaceActive} />
      <SettingsRow
        label="Share anonymous usage data"
        hint="Anonymous feature and performance metadata. Never your code, prompts, or keys."
      >
        <Switch
          checked={!optedOut}
          onCheckedChange={toggle}
          aria-label="Share anonymous usage data"
        />
      </SettingsRow>
    </SettingsGroup>
  );
}

function IntegrationsPanel({ surfaceActive = true }: { surfaceActive?: boolean }) {
  const organization = useActiveOrganization();
  const { me } = useTeams();
  const organizationId = organization?.isPersonal ? null : organization?.id ?? getActiveOrganizationIdSnapshot();
  return <div className="flex flex-col gap-8">
    {organizationId && isFeatureEnabled("cloud-workspaces") ? me && <CloudGithubSection key={`${me.user.id}:${organizationId}`} userId={me.user.id} organizationId={organizationId} surfaceActive={surfaceActive} />
      : <GitHubSection surfaceActive={surfaceActive} />}
  </div>;
}

// Every section in SECTIONS renders a real control. Reintroducing a
// "coming soon" panel is a step backwards: register the section only once it
// has something to show.

// Agent and model form one global default (one star across the model menu).
// With no choice, connected providers resolve Codex → Claude → Cursor. Effort
// and Fast are remembered per exact model in the model menu.

/** Filled card with `--border1` hairlines. The fill is `--bg1-bright`, not
 *  `--bg3`: light bg3 equals bg1 (white), so the card would vanish (check:ui
 *  guards this). Rows carry the 12px vertical padding; the box has none. */
const MODELS_SECTION_CLS =
  "bg-bg1-bright divide-border1 rounded-lg px-3 [&>*]:py-3";

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

  // Populate the shared agent-registry cache (same pattern as the "+" menu)
  // so the model list has data; stale-while-revalidate from the cache.
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
  // The one model a new chat opens on. Selecting it here moves the global star.
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
    // Durable mirror → user settings.toml [models] (setDefault only writes
    // the localStorage cache + pub/sub).
    mirrorModelsToSettings();
  };

  return (
    <div className="flex flex-col gap-4">
      <SettingsList className={MODELS_SECTION_CLS}>
        <SettingsRow label="Default agent" hint="Agent for new chats">
          <div className="flex items-center gap-2">
            <Select value={effectiveAgentId ?? ""} onValueChange={pickAgent}>
              <SelectTrigger aria-label="Default agent" data-default-agent-picker>
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
            {/* Picking a model moves the one global favorite star. Effort/Fast
                stay model-owned and are edited from the composer's model menu. */}
            {effectiveAgentId && currentModel && (
              <Select
                value={currentModel}
                onValueChange={(model) =>
                  starFavoriteModel(effectiveAgentId, model)
                }
              >
                <SelectTrigger aria-label="Default model" data-default-model-picker>
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
          hint="Up to 500 characters of your first message are sent to OpenAI"
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
            <p className="text-muted-fg text-xs">
              These controls save to Codex’s native configuration on this device
              and also affect Codex outside Zeros. Memories remain in Codex’s
              own storage.
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
                hint="Let Codex learn reusable project context on this device"
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
                hint="Allow chats that use tools to contribute local memories"
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
                hint="Remove memories Codex has learned on this device"
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
            <DialogDescription>
              This removes the local memories Codex has learned on this device.
              It does not delete your Zeros chats.
            </DialogDescription>
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

/** Global git defaults. Branch naming lives here (a personal preference —
 *  see git-defaults-section.tsx); remote + base branch stay per-repo on each
 *  repo's own Git pane, because those ARE properties of the repo. */
function GitDefaultsPanel() {
  return (
    <div className="flex flex-col gap-9">
      <GitDefaultsSection />
    </div>
  );
}

// Thin wrapper so the launch-profile section component stays presentational.
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
    <div className="flex flex-col gap-6">
      <p className={HINT_CLS}>
        Experimental features that are under development.{" "}
        <span className="text-fg1 font-medium">Expect breaking changes.</span>
      </p>
      <SettingsGroup>
        <SettingsRow
          label="Terminal Agents"
          hint="Adds a Terminal Agents tab for configuring coding CLIs in the terminal panel."
        >
          <Switch
            checked={terminalAgents}
            onCheckedChange={setTerminalAgents}
            aria-label="Show the Terminal Agents tab"
          />
        </SettingsRow>
        <SettingsRow
          label="Hide archived workspaces after 15 days"
          hint="Hides workspaces archived for 15 days. Chats and snapshots are kept."
        >
          <Switch
            checked={hideArchived}
            onCheckedChange={setHideArchived}
            aria-label="Hide archived workspaces after 15 days"
          />
        </SettingsRow>
        <SettingsRow
          label="Gibberish agent thinking"
          hint="While the agent works, a shimmering, misspelled word like “Thenkeng” sits beside its timer."
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

// Allowlisted-account-only switches (settings/internal-features.ts), not
// experimental features: they may never ship. Each flag applies to this app
// install only, because every channel has its own localStorage, so a feature can
// be on in Beta and off in Production.
function InternalPanel() {
  const [copyLogs, setCopyLogs] = useInternalFeature("copyLogs");
  const [resourceSummary, setResourceSummary] = useInternalFeature("resourceSummary");
  const agentControlFeatures = agentControlFeaturesAt("internal");
  return (
    <div className="flex flex-col gap-6">
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

// Dark and Light are the only themes; System follows macOS.

const THEME_OPTIONS: Array<{ value: ThemeMode; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

function AppearancePanel() {
  const { prefs, setPrefs } = useAppearance();
  // The picker only lists themes readable on the CURRENT variant's uniform
  // code bg (dark themes for the dark app, light for light), and each variant
  // remembers its own pick — prefs.codeTheme is already resolved per variant,
  // so the Select's value is always present in the filtered list.
  const variant = useThemeVariant();
  const codeThemes = codeThemesForVariant(variant);

  return (
    <div className="flex flex-col gap-6">
      <SettingsGroup>
        <SettingsRow
          label="Theme"
          hint="Choose the app color theme. System follows macOS."
        >
          <Select
            value={prefs.mode}
            onValueChange={(v) => setPrefs({ mode: v as ThemeMode })}
          >
            <SelectTrigger>
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
      </SettingsGroup>

      <SettingsGroup title="Code">
        <SettingsRow
          label="Code theme"
          hint="Syntax colors for code blocks, diffs, the editor, and terminal."
        >
          <Select
            value={prefs.codeTheme}
            onValueChange={(v) => setPrefs({ codeTheme: v })}
          >
            <SelectTrigger>
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
        {/* The preview is its own divided row (the card's `[&>*]:py-3`
            pads it) so it reads as part of the card rather than a stray
            block hanging under the picker. */}
        <div>
          <CodeThemePreview />
        </div>
      </SettingsGroup>
    </div>
  );
}
