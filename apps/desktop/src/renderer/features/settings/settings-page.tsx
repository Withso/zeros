// ──────────────────────────────────────────────────────────
// Settings page — sidebar + per-section panel
// ──────────────────────────────────────────────────────────
//
// Sidebar + detail pane: ONE sidebar with grouped
// sections (Personal / Agents / Workspace / Administration). This page
// owns the USER scope only; repository settings live on each repository page
// (Home rail → repository → Settings tab).
// Settings is its own page: this section nav is the MAIN sidebar (the
// Home rail is hidden while here), with a Back row (→ Home tab) at its
// top. There is no header bar — "Open settings.toml" (reveal in Finder)
// floats at the detail pane's top-right, mirroring the repo page; the
// global top bar owns the macOS traffic lights. The sidebar sits flat on
// the page canvas (`--sidebar-bg`); the detail pane is flat `--bg1`
// separated by a single `border-l` seam, content in a centered reading
// column.
//
// Active selection encoding — one string persisted under
// `settings:active-section`:
//   - `user:<sectionId>`                → a User-scope section
//   - `repo:<projectId>:<repoSection>`  → LEGACY; redirects to the repo
//     page's Settings tab (kept parsing so old deep links keep working)
// Legacy bare `general` / `repo:<id>` values migrate forward on read.
//
// 2026-05-22 (Settings revamp): Agents → Providers rename + API Keys
// folded into the Providers panel. Provider auth-method + binary-path
// overrides live in provider-prefs.ts, consumed at session spawn time.
//
// 2026-08-08: nav LABELS only — Preferences → "General", Agent providers →
// "Agents", Git → "Git & PR". `SectionId`s are untouched, so persisted
// `settings:active-section` values and deep links keep resolving.
//
// Repositories live in their own repository scope rather than a bottom sidebar
// group; the
// per-repo detail gained a background-less section nav. Repo settings are
// engine-owned TOML (bridge ops), not localStorage.
// ──────────────────────────────────────────────────────────

import React, {
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
  Building2,
  Astroid,
  Plus,
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
  UsersRound,
  type LucideIcon,
} from "lucide-react";
import {
  useActivePage,
  useWorkspaceDispatch,
  useWorkspaceStore,
} from "../../state/store";
import { Button, Input } from "../../shared/ui";
import { Tooltip } from "@/renderer/shared/ui/primitives";
import { cn } from "@/renderer/shared/ui/cn";
import { Switch } from "../../shared/ui/primitives/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../shared/ui/primitives/select";
import { getSetting, setSetting } from "../../platform/settings";
import { useAppearance } from "../../shared/theme/provider";
import { type ThemeMode } from "../../shared/theme/prefs";
import { codeThemesForVariant } from "../../shared/theme/code-themes";
import { useThemeVariant } from "../../shared/theme/use-theme-variant";
import { CodeThemePreview } from "./code-theme-preview";
import { useProjects } from "../../state/use-projects";
import { ProvidersPanel } from "./providers-panel";
import { TerminalAgentsSection } from "./terminal-agents-section";
import { GitDefaultsSection } from "./git-defaults-section";
import { useExperimentalFeature } from "./experimental-features";
import { useInternalFeature, useIsInternalUser } from "./internal-features";
import {
  UserEnvironmentPanel,
  isRepoSectionId,
  type RepoSectionId,
} from "../repositories/repositories-panel";
import { repoPageViewForSection } from "../repositories/repo-page";
import { OpenSettingsFileButton } from "../../shared/ui/open-settings-file-button";
import { GitHubSection } from "./github-section";
import { prefetchGithubAuthSnapshot } from "./github-auth-prefetch";
import { TeamPanel } from "../team/team-panel";
import { MembersPanel } from "../team/members-panel";
import { CreateTeamDialog } from "../team/create-team-dialog";
import { JoinTeamDialog } from "../team/join-team-dialog";
import {
  consumePendingInviteToken,
  subscribePendingInvite,
} from "../team/invite-link";
import { CONTROL_PLANE_URL } from "../team/control-plane";
import {
  lastKnownHasTeams,
  subscribeCreateTeamDialog,
  useTeams,
} from "../team/team-store";
import { isAnalyticsOptedOut } from "../../platform/observability/analytics/consent";
import { setAnalyticsEnabled } from "../../platform/observability/analytics/posthog";
import { useAuth } from "../auth";
import { useBridge, useBridgeStatus } from "../../platform/bridge/use-bridge";
import { ensureSettingsTomlMigrated } from "./migrate-legacy";
import { subscribeUserSettingsSection } from "./settings-navigation";
import {
  SettingsEmpty,
  SettingsList,
  SettingsRow,
  SettingsSection,
} from "./settings-ui";
import { useAgentSessions } from "../agent/sessions-hooks";
import { useEnabledAgents } from "../agent/enabled-agents";
import { useAgentsSnapshot, loadAgents } from "../agent/agents-cache";
import { isRunnableAgent } from "../agent/agent-runnable";
import {
  agentFamily,
  displayModelLabel,
  modelsForAgent,
} from "../agent/model-catalog";
import {
  effectiveFavoriteModel,
  useFavoritesVersion,
} from "../agent/model-favorites";
import {
  CHAT_TITLE_MODEL_OPTIONS,
  mirrorModelsToSettings,
  starFavoriteModel,
  useChatTitleModel,
  useDefaultPlanMode,
} from "../agent/new-chat-defaults";
import {
  CLAUDE_IDLE_TIMEOUT_OPTIONS,
  DEFAULT_BUDGET_CAP_USD,
  DEFAULT_CLAUDE_IDLE_TIMEOUT_MINUTES,
  useClaudeBudgetCap,
  useClaudeFallbackModel,
  useClaudeIdleTimeoutMinutes,
} from "../agent/reliability-settings";
import { AgentIcon } from "../agent/agent-icon";
import { useDefaultAgent, pickDefaultAgentId } from "./default-agent";

type SectionId =
  | "general"
  | "appearance"
  | "models"
  | "providers"
  | "terminal-agents"
  | "environment"
  | "git"
  | "repos"
  | "team"
  | "members"
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

// Internal's nav row is the ONE coloured entry in the rail — label AND icon
// carry `--brown-primary` (the warm accent) in every state, so a staff-only
// tab reads as staff-only at a glance instead of sitting silently among the
// fg2 rows. Declared ABOVE `SECTIONS` because the array evaluates at module
// load and a `const` below would be in its temporal dead zone. Every state
// SIDEBAR_ENTRY_CLS paints (rest / hover / active / active+hover, row + svg)
// is restated here so twMerge — which keeps the LAST class per group+modifier
// — swaps them all; miss one and that state falls back to fg1/fg2.
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
    id: "providers",
    label: "Agents",
    icon: Astroid,
    Panel: ProvidersPanel,
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
  // "mcp" left Settings entirely (2026-07-22): MCP servers are managed on the
  // Customize page (Home rail → Customize), scoped User / per-repo. A stale
  // persisted `user:mcp` selection redirects there (see the effect below).
  // "repos" left the settings tree because repository settings live on each
  // repository's page. The id
  // stays in SectionId only so legacy `repo:<id>:<section>` selections keep
  // parsing — the redirect effect below sends them to the repo page.
  // Administration pair — gated in `availableSections`: hidden entirely
  // while the signed-in user has ZERO teams (teams are optional since
  // 2026-07-22; nothing is auto-created at sign-in). The sidebar shows a
  // "+ Create team" entry in their place — see the nav.
  {
    id: "team",
    label: "Team",
    icon: Building2,
    Panel: TeamPanel,
  },
  {
    id: "members",
    label: "Members",
    icon: UsersRound,
    Panel: MembersPanel,
  },
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
  // Gated to staff accounts (`users.staff_role`, served by GET /v1/me — see
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

// Sidebar grouping — the nav renders these labelled groups (in order),
// each listing the SECTIONS entries named by id. A section gated off in
// `availableSections` (e.g. terminal-agents behind its experimental
// flag) just drops out of its group. The per-repo "Your Repos" list
// renders after these, straight from the projects store.
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
  { label: "Agents", ids: ["models", "providers", "terminal-agents"] },
  { label: "Workspace", ids: ["environment", "git"] },
  { label: "Administration", ids: ["team", "members"] },
];

// ── Active-selection encoding ───────────────────────────
//
// One persisted string drives the whole page. Two scopes (the
// User/Repo toggle), encoded so a single value restores both which
// scope AND which section/repo on reload:
//
//   user:<sectionId>                 — a User-scope section
//   repo:<projectId>:<repoSection>   — a repo + its open section
//
// Legacy values (bare `general` / `repo:<id>`) map forward on read.

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
      // (2026-07-17) and also lands on the default Environment view.
      const maybeSection =
        raw === "scripts" || raw === "run-actions" || raw === "mcp"
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
  // "Organization" became "Team" (2026-07-25) — carry a persisted selection
  // forward instead of silently dumping the user on General.
  const bare = rawBare === "organization" ? "team" : rawBare;
  return { scope: "user", section: isStaticSection(bare) ? bare : "general" };
}

// ── Shared layout class strings ──────────────────────────
//
// The flat section/row/list vocabulary now lives in settings-ui.tsx
// (SettingsSection / SettingsRow / SettingsList). Only the page-level
// heading and a one-off hint string remain here.

// `text-lg` = 1.125rem = 18px at the app's 16px rem base. One class governs
// every settings tab's <h1>.
const PAGE_HEADING_CLS = "m-0 text-lg font-medium leading-tight text-fg1";

const HINT_CLS = "text-sm text-fg2";

const SETTINGS_SECTION_KEY = "settings:active-section";
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

function loadInitialSection(): string {
  // Normalize to the canonical encoding so legacy values (bare `general`,
  // `repo:<id>` without a section) migrate forward on first read. A
  // `repo:<id>:<section>` value passes through; its repo id is re-validated
  // against the project list in the mount-time effect once projects hydrate.
  const sel = parseSelection(
    getSetting<string>(SETTINGS_SECTION_KEY, "user:general"),
  );
  return sel.scope === "user"
    ? userSelection(sel.section)
    : repoSelection(sel.repoId, sel.section);
}

// Sidebar entry button — shared shape for static sections + per-repo
// rows. Hoisted out of the JSX so the long class string isn't
// duplicated and the active-state contract stays in one place.
// HEIGHT: `py-1.5` + the `text-sm` line-box (20px) → a 32px row; the
// list spaces rows apart with `gap-1` (see the nav).
// WEIGHT: every row stays `font-normal`, selected included — selection is
// encoded by COLOR only (`fg2 → fg1` + the lifted background), so rows
// don't visually shift width when the choice changes.
// HOVER: lifts only the BACKGROUND (`hover:bg-sidebar-bg-hover`, same as
// the selected row — the nav sits on the page's `--sidebar-bg` canvas, and
// `--bg1-hover` would be invisible there since it equals `--sidebar-bg`).
// The label + icon
// keep `fg2` — `hover:text-fg2` is REQUIRED to cancel the ghost Button
// variant's built-in `hover:text-fg1` (twMerge keeps the later class);
// without it the label pops to fg1 on hover. The selected row keeps
// `fg1` even while hovered via the higher-specificity
// `data-[state=active]:hover:text-fg1`.
// ICON SIZE: 14px, set in CSS — NOT via each icon's `size` prop. The Button
// primitive paints `[&_svg]:size-4` on every button, and a CSS width/height
// beats the `width`/`height` ATTRIBUTES lucide's `size` prop emits, so
// `<Icon size={14} />` alone still rendered 16px. `[&_svg]:size-3.5` reuses
// the primitive's exact selector so twMerge drops the 16px rule outright
// rather than leaving two rules to fight on source order.
const SIDEBAR_ENTRY_CLS =
  "flex h-auto w-full min-w-0 items-center justify-start gap-2.5 rounded-md border-0 bg-transparent px-2.5 py-1.5 text-left text-sm font-normal text-fg2 transition-colors duration-150 ease-out hover:bg-sidebar-bg-hover hover:text-fg2 data-[state=active]:bg-sidebar-bg-hover data-[state=active]:text-fg1 data-[state=active]:hover:text-fg1 [&_svg]:size-3.5 [&>svg]:shrink-0 [&>svg]:text-fg2 data-[state=active]:[&>svg]:text-fg1";

// Group label in the section list ("Personal" / "Agents" / …) — a quiet,
// non-interactive divider. `pt-5` opens a clear gap above it (the FIRST
// label overrides to `pt-1`); `text-muted-fg` keeps it subordinate to
// the row labels.
const SETTINGS_GROUP_HEADER_CLS =
  "select-none px-2.5 pb-1.5 pt-5 text-xs font-normal text-muted-fg";

export function SettingsPage() {
  const pageSurfaceRef = useRef<HTMLDivElement | null>(null);
  const dispatch = useWorkspaceDispatch();
  const pageActive = useActivePage() === "settings";
  const { projects } = useProjects();
  // Persisted across reloads via native settings — Cmd+R on Providers
  // lands you back on Providers, not General. Type-guarded on read so
  // a stale value from a renamed section can never crash mount; repo
  // ids are re-validated below once `projects` hydrates.
  const [active, setActiveState] = useState<string>(loadInitialSection);
  const setActive = (next: string) => {
    setActiveState(next);
    setSetting(SETTINGS_SECTION_KEY, next);
  };
  const selection = parseSelection(active);
  useInstantViewSwitch(`settings:${active}`, pageSurfaceRef);

  // Deep links from action-error toasts must update this retained page as well
  // as persistence; otherwise reopening an already-mounted Settings surface
  // would show its stale prior section.
  useEffect(
    () =>
      subscribeUserSettingsSection((section) => {
        if (isStaticSection(section)) {
          setActiveState(userSelection(section));
        }
      }),
    [],
  );

  // Administration dialogs — Create team (sidebar entry at zero teams,
  // team-switcher "New team") and Join team (invite deep links). Both
  // render HERE, not in a panel: a zero-team user has NO Administration
  // tabs, so the panels can't host them.
  const [createTeamOpen, setCreateTeamOpen] = useState(false);
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

  // Panels ask for the create dialog via the team-store bus (the team
  // switcher's "New team" item lives in a different tree).
  useEffect(() => {
    return subscribeCreateTeamDialog(() => setCreateTeamOpen(true));
  }, []);

  // One-time import of the legacy localStorage
  // settings blobs into the engine-owned TOML files. Flag-guarded + merge-under
  // on the engine side, so calling on every settings open is safe.
  const bridge = useBridge();
  useEffect(() => {
    void ensureSettingsTomlMigrated(bridge);
  }, [bridge]);

  // Legacy repository-selection redirect: repository settings moved to the repository page
  // (one Workspaces/section toggle), so a persisted / deep-linked
  // `repo:<id>:<section>` selection re-routes there and the settings page
  // resets to its first section. The empty-at-mount guard mirrors the old
  // revalidation effect: an un-hydrated project list (the async web fetch)
  // must not eat a restored repo selection before the redirect can resolve it.
  const prevProjectsLenRef = useRef(projects.length);
  useEffect(() => {
    const prevLen = prevProjectsLenRef.current;
    prevProjectsLenRef.current = projects.length;
    const sel = parseSelection(active);
    if (sel.scope !== "repo") return;
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
  }, [projects, active, dispatch]);

  // MCP left Settings for the Customize page (2026-07-22). A persisted or
  // deep-linked `user:mcp` (or legacy bare `mcp`) selection re-routes there;
  // the settings page resets to its first section so the retired key never
  // lingers. (parseSelection already maps the unknown id to "general", so
  // this checks the RAW persisted string.)
  useEffect(() => {
    const bare = active.startsWith("user:")
      ? active.slice("user:".length)
      : active;
    if (bare !== "mcp") return;
    setActive(userSelection("general"));
    dispatch({ type: "SET_ACTIVE_PAGE", page: "customize" });
    // setActive is stable for the component's lifetime (state setter + setSetting).
  }, [active, dispatch]);
  // Experimental gating: the Terminal Agents tab is hidden — and not
  // resolvable as an active section — until opted in from Experimental.
  // `availableSections` drops the gated entries when their flag is off,
  // so a stale `user:terminal-agents` selection falls back to the first
  // section instead of rendering a panel with no sidebar entry.
  //
  // Internal gating: the Internal tab exists ONLY for allowlisted
  // internal accounts (settings/internal-features.ts). Same mechanism —
  // dropping it here hides the sidebar row and makes a stale/forged
  // `user:internal` selection unresolvable, so signing out (or into a
  // non-internal account) can never leave the panel reachable.
  const [terminalAgentsEnabled] = useExperimentalFeature("terminalAgents");
  const internalUser = useIsInternalUser();
  // Administration gating: teams are OPTIONAL — with the control plane
  // configured and the team list empty, the Team/Members tabs drop out and
  // the sidebar offers "+ Create team" instead. While the first fetch is
  // still in flight, the persisted last-known answer stands in so a
  // zero-team user doesn't watch the tabs flash in and vanish on every
  // launch; the live store wins once "ready".
  const { me: teamsMe, status: teamsStatus } = useTeams();
  const zeroTeams =
    !!CONTROL_PLANE_URL &&
    (teamsStatus === "ready"
      ? (teamsMe?.teams.length ?? 0) === 0
      : lastKnownHasTeams() === false);
  const availableSections = useMemo(
    () =>
      SECTIONS.filter(
        (s) =>
          (s.id !== "terminal-agents" || terminalAgentsEnabled) &&
          (s.id !== "internal" || internalUser) &&
          ((s.id !== "team" && s.id !== "members") || !zeroTeams),
      ),
    [terminalAgentsEnabled, internalUser, zeroTeams],
  );
  const activeSection: SectionDef | null =
    selection.scope === "user"
      ? (availableSections.find((s) => s.id === selection.section) ??
        availableSections[0])
      : null;
  // Normalize a selection whose section a gate just dropped (zero teams
  // hiding team/members, an experimental/internal flag flipping
  // off): the fallback panel above already renders, but without this
  // rewrite the sidebar shows NO active row and — worse — the retired
  // selection lies in wait, spontaneously reactivating if its gate ever
  // reopens.
  useEffect(() => {
    if (selection.scope !== "user") return;
    if (availableSections.some((s) => s.id === selection.section)) return;
    const fallback = availableSections[0]?.id;
    if (fallback) setActive(userSelection(fallback));
    // setActive is stable for the component's lifetime (state setter + setSetting).
  }, [availableSections, selection.scope, selection.section]);
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

  // Every section panel shares the ONE detail scroller below, and inactive
  // panels hide with display:none — so a section switch collapses the content
  // and the browser clamps scrollTop. Keyed memory gives each section its own
  // remembered offset: switching back lands exactly where the user left,
  // switching to an unvisited section starts at the top.
  const detailScrollRef = useScrollMemoryRef(
    activeSection ? `settings:${activeSection.id}` : null,
  );

  // Back returns to the Home tab (Dashboard); Settings is its own page now,
  // with its section nav as the main sidebar (the Home rail is hidden here).
  const handleBack = () => {
    dispatch({ type: "SET_ACTIVE_PAGE", page: "dashboard" });
  };

  // File-scope control — "Open settings.toml" reveals the user file in Finder
  // (the same affordance as the repo page). Floats at the content's top-right.
  // Self-hides when the native Finder integration is unavailable.
  const fileScopeControls = (
    <OpenSettingsFileButton
      layer="user"
      label="Open settings.toml"
      tooltip="~/.zeros/settings.toml — reveal in Finder"
      seed={USER_SETTINGS_SEED}
    />
  );

  return (
    <div
      ref={pageSurfaceRef}
      className="bg-sidebar-bg flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden"
    >
      {/* No header bar: Settings is its own
          page — the section nav below is the MAIN sidebar with a Back row at
          its top (→ Home tab), and "Open settings.toml" floats at the content's
          top-right, mirroring the repo page. The global top bar owns the macOS
          traffic lights + window drag. */}
      <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {/* Sidebar — the MAIN nav now (the Home rail is hidden on Settings).
              A Back row (→ Home tab) sits at the top, then the labelled
              SECTION_GROUPS. Repo settings live on each repo's page. */}
        <nav
          className="flex shrink-0 basis-[256px] flex-col overflow-y-auto px-3 pt-4 pb-2"
          role="tablist"
          aria-label="Settings sections"
        >
          <Tooltip label="Back to home">
            <Button
              variant="ghost"
              className={cn(SIDEBAR_ENTRY_CLS, "mb-2")}
              onClick={handleBack}
            >
              <ArrowLeft size={14} strokeWidth={1.5} />
              <span>Back</span>
            </Button>
          </Tooltip>
          {SECTION_GROUPS.map((group, groupIndex) => {
            const sections = group.ids.flatMap((id) => {
              const section = availableSections.find((s) => s.id === id);
              return section ? [section] : [];
            });
            // Zero teams empties the Administration group (its tabs are
            // gated off) — it renders a "+ Create team" entry instead of
            // vanishing, keeping team creation reachable as the
            // LAST item of the sidebar. Other empty groups still hide.
            const isAdministration = group.label === "Administration";
            if (sections.length === 0 && !(isAdministration && zeroTeams)) {
              return null;
            }
            return (
              <React.Fragment key={group.label}>
                <div
                  className={cn(
                    SETTINGS_GROUP_HEADER_CLS,
                    groupIndex === 0 && "pt-1",
                  )}
                >
                  {group.label}
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
                          : undefined
                      }
                    />
                  ))}
                  {isAdministration && zeroTeams && (
                    <Button
                      variant="ghost"
                      className={SIDEBAR_ENTRY_CLS}
                      onClick={() => setCreateTeamOpen(true)}
                    >
                      <Plus size={14} />
                      <span className="truncate">Create team</span>
                    </Button>
                  )}
                </div>
              </React.Fragment>
            );
          })}
        </nav>

        {/* Detail pane — flat `--bg1`, full-bleed to the window edges, with
              a single `border-l` seam against the sidebar-bg canvas (the
              floating rounded island was retired 2026-07-12). Native
              overflow — macOS overlay scrollbars auto-hide, so no custom
              Radix thumb. Content is a left-aligned reading column matching
              the repo settings page: responsive left gutter (24px floor,
              100px cap) + the same max width and top padding. */}
        <div className="border-border1 bg-bg1 relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border-l">
          {/* "Open settings.toml" floats at the top right, mirroring the repo
              page — a transparent drag strip; the button opts out of drag. */}
          <div
            className="flex shrink-0 items-center justify-end px-6 pt-4"
            data-tauri-drag-region
          >
            {fileScopeControls}
          </div>
          <div ref={detailScrollRef} className="min-h-0 flex-1 overflow-y-auto">
            {/* `settings-type-scale` sets this tab surface's type: NAMES
                14px, everything else 13px (see settings-page.css). Names carry
                `text-[14px]` (settings-ui + the custom labels in the panels)
                so they opt out of the shrink; the scope pulls the remaining
                `text-sm` chrome — dropdown TRIGGERS, buttons — down to 13px.
                Descriptions are native `text-xs` = 13px. Open dropdown LISTS
                are already 13px (Radix portals them to <body>, outside this
                column, and their items are native `text-xs`). */}
            <div className="settings-type-scale w-full max-w-5xl pt-10 pr-6 pb-16 pl-[clamp(1.5rem,5vw,6.25rem)]">
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
                    <Panel surfaceActive={pageActive && isActive} />
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Administration dialogs — page-level so they exist in EVERY team
          state (a zero-team user has no Administration panels to host
          them). Success navigates to the Team tab, which exists again by
          then (both dialogs refresh the team store first). */}
      <CreateTeamDialog
        open={createTeamOpen}
        onOpenChange={setCreateTeamOpen}
        onCreated={() => setActive(userSelection("team"))}
        onSwitchToJoin={() => {
          setCreateTeamOpen(false);
          setJoinToken("");
          setJoinTeamOpen(true);
        }}
      />
      <JoinTeamDialog
        open={joinTeamOpen}
        initialToken={joinToken}
        onOpenChange={setJoinTeamOpen}
        onJoined={() => setActive(userSelection("team"))}
      />
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// Section nav button — one shared shape for both the User and Repo
// section lists in the body's left rail.
// ──────────────────────────────────────────────────────────

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

// ── General ─────────────────────────────────────────────

function GeneralPanel() {
  // Home for general user preferences (the "General" tab — labelled
  // "Preferences" until 2026-08-08; the id has always been `general`, so
  // persisted selections are unaffected). Currently empty —
  // the old archived-chats toggle that lived here was removed as dead
  // pre-revamp wiring. Kept as the landing section; new general
  // preferences slot in as <SettingsSection>s alongside this empty state.
  return (
    <div className="flex flex-col gap-8">
      <SettingsEmpty
        title="No preferences yet"
        hint="General preferences will appear here."
      />
    </div>
  );
}

// ── Account — Zeros account, sign-in methods, sign out ──
//
// Reads the live Auth0 session via useAuth() (main-process-owned; the
// renderer only sees decoded identity claims, never a token). GitHub/Google
// show a "Connect" affordance that lands in a later update (Auth0 account
// linking, not implemented yet). Sign out clears the session — the AuthGate
// then flips back to the login screen.

function providerLabel(provider: string): string {
  if (provider === "github") return "GitHub";
  if (provider === "google") return "Google";
  return provider;
}

/** Auth0's `sub` is prefixed by the connection that authenticated the user
 *  (e.g. "google-oauth2|000000000" or "github|000000000") — since this app only
 *  offers Google + GitHub social connections, that prefix IS the provider. */
function providerFromSub(
  sub: string | null | undefined,
): "github" | "google" | null {
  if (!sub) return null;
  if (sub.startsWith("github|")) return "github";
  if (sub.startsWith("google-oauth2|")) return "google";
  return null;
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
  const primaryProvider = providerFromSub(session?.user.sub);
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
    <div className="flex flex-col gap-8">
      {authed ? (
        <>
          {/* Profile — flat header, no card. Initials only: we don't load remote
              provider avatars (web CSP blocks them; fetching leaks the user's IP
              to Google/GitHub on every Settings open). */}
          <div className="flex items-center gap-3">
            <div className="bg-bg2-hover text-fg1 flex size-12 shrink-0 items-center justify-center rounded-full text-sm font-medium">
              {initial}
            </div>
            <div className="flex min-w-0 flex-col gap-0.5">
              {displayName && (
                <div className="text-fg1 truncate text-[14px] font-medium">
                  {displayName}
                </div>
              )}
              <div className="text-fg2 truncate text-sm">{email}</div>
              {primaryProvider && (
                <div className="text-muted-fg text-xs">
                  Signed in with {providerLabel(primaryProvider)}
                </div>
              )}
            </div>
          </div>

          <SettingsSection
            title="Sign-in methods"
            description="Linking a second provider arrives in a later update."
          >
            <SettingsList>
              <SignInMethodRow
                label="GitHub"
                desc="Link GitHub to sign in with one click."
                connected={linked.has("github")}
              />
              <SignInMethodRow
                label="Google"
                desc="Link Google to sign in with one click."
                connected={linked.has("google")}
              />
            </SettingsList>
          </SettingsSection>

          <SettingsSection title="Sign out">
            <SettingsList>
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
                  className="gap-2"
                >
                  <LogOut size={14} />
                  Sign out
                </Button>
              </SettingsRow>
              <SettingsRow
                label="Sign out everywhere"
                hint="Revoke every active session on all devices. Use this if your account may be compromised."
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
                  className="border-red-primary/40 text-red-primary hover:bg-red-primary/10 hover:text-red-primary gap-2"
                >
                  <LogOut size={14} />
                  Sign out everywhere
                </Button>
              </SettingsRow>
            </SettingsList>
          </SettingsSection>
        </>
      ) : (
        <p className={HINT_CLS}>You're not signed in.</p>
      )}

      {/* Usage data — moved here from the removed Privacy section. Always shown,
          even signed out (it's a device-level analytics consent, not account). */}
      <UsageDataSection />
    </div>
  );
}

// ── Usage data — anonymous usage analytics (opt-out) ──
//
// Single consent control for metadata-only product analytics. Opt-out model:
// on by default, anonymous, and never sends user content. Lives under Account
// now (the standalone Privacy section was removed).

function UsageDataSection() {
  const [optedOut, setOptedOut] = useState<boolean>(() =>
    isAnalyticsOptedOut(),
  );
  const toggle = (enabled: boolean) => {
    setOptedOut(!enabled);
    void setAnalyticsEnabled(enabled);
  };

  return (
    <SettingsSection title="Usage data">
      <SettingsList>
        <SettingsRow
          label="Share anonymous usage data"
          hint="Anonymous metadata only — feature usage, agent success/failure, performance timings. Never your code, prompts, paths, or API keys, and no account or personal identifiers."
        >
          <Switch
            checked={!optedOut}
            onCheckedChange={toggle}
            aria-label="Share anonymous usage data"
          />
        </SettingsRow>
      </SettingsList>
    </SettingsSection>
  );
}

// ── Integrations — external services Zeros connects to (GitHub, …) ──
//
// Moved out of General: GitHub is the keystone integration (PRs, reviews,
// checks), not a "general" toggle. Any future third-party integration joins
// this list.

function IntegrationsPanel({
  surfaceActive = true,
}: {
  surfaceActive?: boolean;
}) {
  return (
    <div className="flex flex-col gap-8">
      <GitHubSection surfaceActive={surfaceActive} />
    </div>
  );
}

// Every section in SECTIONS renders a real control. Reintroducing a
// "coming soon" panel is a step backwards: register the section only once it
// has something to show.

// ── Models — one global default model + plan posture ──
//
// Agent + model form one global default identity (and one star across the model
// menu). With no choice, connected providers resolve Codex → Claude → Cursor;
// their family fallbacks are GPT-5.6 Sol / Opus 5 / Composer 2.5. Effort and
// Fast are edited and remembered per exact model in the model menu.

/** The Models tab groups its rows into filled sections: a borderless
 *  subtle-fill card with `--border1` hairlines
 *  between rows (overrides the SettingsList default `divide-border2`). The
 *  fill is `--bg1-highlight`, NOT the requested `--bg3`: in dark they're
 *  near-identical (#181716 vs #151413), but light bg3 = bg1 = white so the
 *  card would vanish (check:ui guards this); same recipe as the
 *  repositories-panel list card.
 *
 *  Padding = 12px on all four sides: `px-3`
 *  insets left/right, and `[&>*]:py-3` sets each row's vertical padding to
 *  12px (overriding SettingsRow's default `py-3.5`) — the box carries NO py
 *  of its own, so the edge-to-content gap is exactly the row's 12px top and
 *  bottom, and adjacent rows sit 24px apart (tighter than the old 28px). */
const MODELS_SECTION_CLS =
  "bg-bg1-highlight divide-border1 rounded-lg px-3 [&>*]:py-3";

function ModelsPanel() {
  const sessions = useAgentSessions();
  const bridgeStatus = useBridgeStatus();
  const agents = useAgentsSnapshot();
  const { isEnabled } = useEnabledAgents();
  const { agentId: defaultAgentId, setDefault } = useDefaultAgent();

  // Populate the shared agent-registry cache (same pattern as the "+" menu)
  // so the model list has data; stale-while-revalidate from the cache.
  const listAgentsRef = useRef(sessions.listAgents);
  useEffect(() => {
    listAgentsRef.current = sessions.listAgents;
  }, [sessions]);
  useEffect(() => {
    if (bridgeStatus !== "connected") return;
    loadAgents((force) => listAgentsRef.current(force)).catch(() => {
      /* engine respawn / bridge blip — the next connect re-runs */
    });
  }, [bridgeStatus]);

  // Runnable, enabled agents whose family we have a curated catalog for
  // (claude / codex / cursor), name-sorted for a stable dropdown.
  const modelAgents = (agents ?? [])
    .filter((a) => isEnabled(a.id, a.beta) && isRunnableAgent(a))
    .filter((a) => agentFamily(a.id) !== "")
    .sort((a, b) => a.name.localeCompare(b.name));

  // The effective default agent: the user's star if runnable, else the
  // fallback (codex) — so the picker mirrors what new chats actually use.
  const effectiveAgentId =
    modelAgents.find(
      (agent) =>
        agent.id === defaultAgentId ||
        agentFamily(agent.id) === agentFamily(defaultAgentId),
    )?.id ??
    pickDefaultAgentId(agents ?? []) ??
    modelAgents[0]?.id ??
    null;

  // Read the effective model synchronously from the same atomic selection as
  // the agent. A family switch must never paint one frame with the prior
  // family's model in the new provider's Select.
  useFavoritesVersion();
  const [planDefault, setPlanDefault] = useDefaultPlanMode();
  const [titleModel, setTitleModel] = useChatTitleModel();
  // Claude reliability knobs (fallback model + per-turn budget).
  const [fallbackModel, setFallbackModel] = useClaudeFallbackModel();
  const [budgetCap, setBudgetCap] = useClaudeBudgetCap();
  const [idleTimeoutMinutes, setIdleTimeoutMinutes] =
    useClaudeIdleTimeoutMinutes();
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
  // The $-amount field edits locally and commits on blur/Enter so a
  // half-typed "0" never lands in settings.
  const [budgetDraft, setBudgetDraft] = useState<string | null>(null);
  const commitBudgetDraft = () => {
    if (budgetDraft == null) return;
    const v = Number.parseFloat(budgetDraft);
    setBudgetCap(Number.isFinite(v) && v > 0 ? v : budgetCap);
    setBudgetDraft(null);
    applyClaudeSettings();
  };
  // The Claude family's curated models — the fallback picker's options.
  const claudeModels = modelsForAgent("claude", null);

  // Families with a connected (runnable + enabled) agent — gates which
  // "Custom models" picks are selectable (Haiku needs Claude, Luna needs
  // Codex, Composer 2.5 needs Cursor). At runtime a disconnected pick
  // falls down the Haiku → Luna → Composer chain to a connected one.
  const connectedFamilies = new Set(modelAgents.map((a) => agentFamily(a.id)));

  // The one model a new chat opens on. Selecting it here moves the global star.
  const agentModels = effectiveAgentId
    ? modelsForAgent(effectiveAgentId, null)
    : [];
  const currentModel =
    effectiveFavoriteModel(effectiveAgentId) ?? agentModels[0]?.value ?? null;
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
    // gap-4: tighter spacing between the filled setting sections. The sections
    // stay distinct via their
    // `--bg1-highlight` fill, so they don't need a 32px trough between them.
    <div className="flex flex-col gap-4">
      <SettingsList className={MODELS_SECTION_CLS}>
        <SettingsRow label="Default agent" hint="Agent for new chats">
          <div className="flex items-center gap-2">
            <Select value={effectiveAgentId ?? ""} onValueChange={pickAgent}>
              <SelectTrigger className="min-w-[150px]">
                <SelectValue placeholder="Select an agent" />
              </SelectTrigger>
              <SelectContent className="min-w-[180px]">
                {modelAgents.length === 0 ? (
                  <div className="text-fg2 px-2 py-1.5 text-xs">
                    No agents available.
                  </div>
                ) : (
                  modelAgents.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      <span className="flex items-center gap-2">
                        {/* Keep provider marks in their documented brand colors. */}
                        <AgentIcon
                          agentId={a.id}
                          iconUrl={a.icon ?? null}
                          size={14}
                          className="shrink-0"
                        />
                        {a.name}
                      </span>
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
                <SelectTrigger
                  className="min-w-[150px]"
                  aria-label="Default model"
                >
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
          label="Custom models"
          hint="Models used for generating chat titles"
        >
          <Select
            value={titleModel}
            onValueChange={(v) =>
              setTitleModel(
                v as (typeof CHAT_TITLE_MODEL_OPTIONS)[number]["value"],
              )
            }
          >
            <SelectTrigger className="min-w-[150px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="min-w-[180px]">
              {CHAT_TITLE_MODEL_OPTIONS.map((opt) => (
                <SelectItem
                  key={opt.value}
                  value={opt.value}
                  disabled={!connectedFamilies.has(opt.family)}
                >
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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

      {/* Reliability: what happens when the chosen model is
          overloaded or unavailable. Claude Code only (SDK-native) — the
          section's "Claude" title makes that explicit (2026-07-20: the
          per-row CLAUDE scope pills were replaced by this one heading). */}
      <SettingsSection title="Claude">
        <SettingsList className={MODELS_SECTION_CLS}>
          <SettingsRow
            label="Keep sessions active"
            hint={
              <>
                <span className="block">
                  How long Claude stays ready between turns
                </span>
                {idleTimeoutMinutes > DEFAULT_CLAUDE_IDLE_TIMEOUT_MINUTES && (
                  <span className="text-yellow-fg block">
                    Longer sessions use more memory.
                  </span>
                )}
              </>
            }
          >
            <Select
              value={String(idleTimeoutMinutes)}
              onValueChange={(value) => {
                const option = CLAUDE_IDLE_TIMEOUT_OPTIONS.find(
                  (candidate) => String(candidate.minutes) === value,
                );
                if (!option) return;
                setIdleTimeoutMinutes(option.minutes);
                applyClaudeSettings();
              }}
            >
              <SelectTrigger className="min-w-[150px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="min-w-[180px]">
                {CLAUDE_IDLE_TIMEOUT_OPTIONS.map((option) => (
                  <SelectItem
                    key={option.minutes}
                    value={String(option.minutes)}
                  >
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsRow>
          <SettingsRow
            label="Fallback model"
            hint="Used automatically when the primary model is overloaded or unavailable"
          >
            <Select
              value={fallbackModel ?? "none"}
              onValueChange={(v) => {
                setFallbackModel(v === "none" ? null : v);
                applyClaudeSettings();
              }}
            >
              <SelectTrigger className="min-w-[150px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="min-w-[180px]">
                {claudeModels.map((m) => (
                  <SelectItem key={m.value} value={m.value}>
                    {displayModelLabel("claude", m.label)}
                  </SelectItem>
                ))}
                <SelectItem value="none">None (fail fast)</SelectItem>
              </SelectContent>
            </Select>
          </SettingsRow>
          {/* Budget: a hard per-turn ceiling that ends a turn cleanly
          instead of letting it run away. Off by default. */}
          <SettingsRow
            label="Cap spend per turn"
            hint="Ends the turn with a Turn-stopped record once the cap is hit"
          >
            <Switch
              checked={budgetCap != null}
              onCheckedChange={(on) => {
                setBudgetCap(on ? DEFAULT_BUDGET_CAP_USD : null);
                setBudgetDraft(null);
                applyClaudeSettings();
              }}
              aria-label="Cap spend per turn"
            />
          </SettingsRow>
          {budgetCap != null && (
            <SettingsRow
              label="Maximum per turn"
              hint="The turn ends cleanly when it reaches this amount."
            >
              <div className="flex items-center gap-1.5">
                <span className="text-muted-fg text-xs">$</span>
                <Input
                  type="number"
                  min={0.5}
                  step={0.5}
                  value={budgetDraft ?? budgetCap.toFixed(2)}
                  onChange={(e) => setBudgetDraft(e.target.value)}
                  onBlur={commitBudgetDraft}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitBudgetDraft();
                  }}
                  className="w-24 text-right font-mono tabular-nums"
                  aria-label="Maximum spend per turn in dollars"
                />
              </div>
            </SettingsRow>
          )}
        </SettingsList>
      </SettingsSection>
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

// The Terminal Agents tab body — the launch-profile editor, gated
// behind the `terminalAgents` experimental flag (see SECTIONS). Lives
// here as a thin wrapper so the section component stays presentational.
function TerminalAgentsPanel() {
  return <TerminalAgentsSection />;
}

function ExperimentalPanel() {
  const [terminalAgents, setTerminalAgents] =
    useExperimentalFeature("terminalAgents");
  const [workInLocalMain, setWorkInLocalMain] =
    useExperimentalFeature("workInLocalMain");
  return (
    <div className="flex flex-col gap-6">
      <p className={HINT_CLS}>
        Experimental features that are under development.{" "}
        <span className="text-fg1 font-medium">Expect breaking changes.</span>
      </p>
      <SettingsList>
        <SettingsRow
          label="Terminal Agents"
          hint="Adds a Terminal Agents tab to configure how coding CLIs launch in the terminal panel."
        >
          <Switch
            checked={terminalAgents}
            onCheckedChange={setTerminalAgents}
            aria-label="Show the Terminal Agents tab"
          />
        </SettingsRow>
        <SettingsRow
          label="Work in local main"
          hint="Adds a main tab for each repo's primary checkout, so agents can run against it instead of a worktree."
        >
          <Switch
            checked={workInLocalMain}
            onCheckedChange={setWorkInLocalMain}
            aria-label="Show the main workspace in the top bar"
          />
        </SettingsRow>
      </SettingsList>
    </div>
  );
}

// The Internal tab body — allowlisted-account-only feature switches
// (settings/internal-features.ts). NOT experimental features: these may
// never ship to users, and non-internal accounts never see this tab
// (gated in `availableSections`). Each flag applies to THIS app install
// only — every channel (Zeros / Beta / Dev) has its own localStorage —
// which is the point: enable a feature in Beta, leave it off in
// Production, compare.
function InternalPanel() {
  const [copyLogs, setCopyLogs] = useInternalFeature("copyLogs");
  const [designWorkspaces, setDesignWorkspaces] =
    useInternalFeature("designWorkspaces");
  return (
    <div className="flex flex-col gap-6">
      <p className={HINT_CLS}>
        Internal-only features, visible to staff accounts.{" "}
        <span className="text-fg1 font-medium">
          Switches apply to this app (channel) only
        </span>{" "}
        — Zeros, Zeros Beta, and Zeros Dev each keep their own state.
      </p>
      <SettingsList>
        <SettingsRow
          label="Design workspaces"
          hint="Shows the Design workspace option and enables the internal native design-workspace experience in this app channel."
        >
          <Switch
            checked={designWorkspaces}
            onCheckedChange={setDesignWorkspaces}
            aria-label="Enable design workspaces"
          />
        </SettingsRow>
        <SettingsRow
          label="Copy logs"
          hint="⇧⌘L copies the recent app logs to the clipboard — the same scrubbed ~500 KB JSONL tail a feedback submission attaches."
        >
          <Switch
            checked={copyLogs}
            onCheckedChange={setCopyLogs}
            aria-label="Enable the copy-logs shortcut"
          />
        </SettingsRow>
      </SettingsList>
    </div>
  );
}

// ── Appearance — theme mode + code theme ──
//
// 2026-05-26: hue + intensity sliders removed (see prefs.ts
// history block). Tokens are concrete HSL values in
// zeros-tokens.css.
//
// 2026-07-11: the light theme shipped ([data-theme="light"] block
// in zeros-tokens.css), so Light joins the picker and System now
// genuinely follows macOS.
// 2026-08-08: Dark's structural tokens became neutral; bg1, bg2, and
// sidebar-bg moved one lightness point up. The previous warm palette is
// preserved unchanged as Orka black.

const THEME_OPTIONS: Array<{ value: ThemeMode; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "orka-black", label: "Orka black" },
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
    <div className="flex flex-col gap-8">
      <SettingsList>
        <SettingsRow
          label="Theme"
          hint="Dark uses a neutral palette. Orka black preserves the previous warm-gray dark palette. System follows macOS."
        >
          <Select
            value={prefs.mode}
            onValueChange={(v) => setPrefs({ mode: v as ThemeMode })}
          >
            <SelectTrigger className="min-w-[160px]">
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
        <div>
          <SettingsRow
            label="Code theme"
            hint="Syntax highlighting for code blocks, diffs, the editor, and the terminal. Dark and Orka black share one dark-theme choice; Light remembers its own."
          >
            <Select
              value={prefs.codeTheme}
              onValueChange={(v) => setPrefs({ codeTheme: v })}
            >
              <SelectTrigger className="min-w-[160px]">
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
          <div className="pb-3.5">
            <CodeThemePreview />
          </div>
        </div>
      </SettingsList>
    </div>
  );
}
