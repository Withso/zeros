// Create records a source; only the Create button performs a workspace action.
import { useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  GitBranch,
  GitPullRequest,
  Laptop,
  RefreshCw,
  Search,
} from "lucide-react";
import { Button, GithubIcon } from "../../shared/ui";
import { Tooltip } from "../../shared/ui/primitives";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../shared/ui/primitives/popover";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../../shared/ui/primitives/tabs";
import {
  ghPrList,
  gitListAllBranches,
  gitRepoBranchCatalog,
  isGitErrorShape,
  type Branch,
  type PR,
} from "../../platform/git";
import type { Project } from "../../state/projects-store";
import {
  createLocalBranchesCache,
  createBranchCatalogCache,
  createRemoteCatalogCache,
  GIT_READ_MAX_AGE_MS,
  GITHUB_READ_MAX_AGE_MS,
  openPrsCache,
} from "../../state/read-caches";
import { useCachedRead } from "../../state/use-cached-read";
import { RepositoryIcon } from "../../features/repositories/repository-icon";
import {
  branchBase,
  defaultDispatcherBase,
  type DispatcherBase,
} from "./dispatcher-source";

export type { DispatcherBase } from "./dispatcher-source";
const NO_BRANCHES: Branch[] = [];
const NO_PRS: PR[] = [];
type Tab = "local" | "remote" | "prs";

function sourceReadError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error(isGitErrorShape(error) ? error.message : String(error));
}

async function readCatalog(key: string, fetch = false) {
  const [repoRoot] = JSON.parse(key) as [string, string | null];
  try {
    const catalog = await gitRepoBranchCatalog({ repoRoot, fetch });
    if (!catalog) throw new Error("Repository branches are unavailable.");
    return catalog;
  } catch (error) {
    throw sourceReadError(error);
  }
}
async function readLocalBranches(key: string) {
  const [repoRoot, repoSlug] = JSON.parse(key) as [string, string];
  return gitListAllBranches({ repoRoot, repoSlug }).catch((error: unknown) => {
    throw sourceReadError(error);
  });
}

/** Project intent warms local metadata; only the selected project fetches. */
export function warmCreateSourceProject(project: Project): void {
  if (project.isGitRepository === false) return;
  const catalogKey = JSON.stringify([project.repoRoot, project.originUrl]);
  const localKey = JSON.stringify([project.repoRoot, project.repoSlug]);
  void createBranchCatalogCache
    .load(catalogKey, () => readCatalog(catalogKey), {
      maxAgeMs: GIT_READ_MAX_AGE_MS,
    })
    .catch(() => {});
  void createLocalBranchesCache
    .load(localKey, () => readLocalBranches(localKey), {
      maxAgeMs: GIT_READ_MAX_AGE_MS,
    })
    .catch(() => {});
}

interface CreateFromSourceProps {
  project: Project | null;
  value: DispatcherBase | null;
  onChange: (base: DispatcherBase | null) => void;
  active?: boolean;
  disabled?: boolean;
}

export function CreateFromSource({
  project,
  value,
  onChange,
  active = true,
  disabled = false,
}: CreateFromSourceProps) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab | null>(null);
  const [query, setQuery] = useState("");
  const repoRoot = project?.repoRoot ?? null;
  const catalogKey = project
    ? JSON.stringify([project.repoRoot, project.originUrl])
    : null;
  const localKey = project
    ? JSON.stringify([project.repoRoot, project.repoSlug])
    : null;
  const catalogRead = useCachedRead(
    createBranchCatalogCache,
    catalogKey,
    readCatalog,
    { enabled: active, maxAgeMs: GIT_READ_MAX_AGE_MS },
  );
  const remoteRead = useCachedRead(
    createRemoteCatalogCache,
    catalogKey,
    (key) => readCatalog(key, true),
    { enabled: active, maxAgeMs: GITHUB_READ_MAX_AGE_MS },
  );
  const branchesRead = useCachedRead(
    createLocalBranchesCache,
    localKey,
    readLocalBranches,
    { enabled: active, maxAgeMs: GIT_READ_MAX_AGE_MS },
  );
  // Network refresh never hides the fast local-ref snapshot. A later settings
  // or Git invalidation may publish a newer fast snapshot, which wins in turn.
  const catalog =
    remoteRead.data && remoteRead.updatedAt > catalogRead.updatedAt
      ? remoteRead.data
      : catalogRead.data;
  const branches = branchesRead.data ?? NO_BRANCHES;
  const remote = catalog?.remotes.find(
    (r) => r.name === catalog.effectiveRemote,
  );
  const defaultBase = useMemo(
    () => defaultDispatcherBase(catalog, branches, repoRoot ?? ""),
    [catalog, branches, repoRoot],
  );
  const selected = value ?? defaultBase;
  const originUrl = remote?.isGitHub ? remote.url : null;
  const requestedTab =
    tab ??
    (selected?.kind === "pr"
      ? "prs"
      : selected?.source === "local"
        ? "local"
        : remote
          ? "remote"
          : "local");
  const activeTab: Tab =
    (requestedTab === "remote" && !remote) ||
    (requestedTab === "prs" && !originUrl)
      ? "local"
      : requestedTab;
  const prsRead = useCachedRead(
    openPrsCache,
    originUrl,
    (key) =>
      ghPrList({ originUrl: key, state: "open" }).catch((error: unknown) => {
        throw sourceReadError(error);
      }),
    {
      enabled: active && open && activeTab === "prs",
      maxAgeMs: GITHUB_READ_MAX_AGE_MS,
    },
  );

  useEffect(() => {
    if (!active || disabled) setOpen(false);
  }, [active, disabled]);

  const warm = () => {
    if (!active || disabled || !catalogKey || !localKey) return;
    void createBranchCatalogCache
      .load(catalogKey, () => readCatalog(catalogKey), {
        maxAgeMs: GIT_READ_MAX_AGE_MS,
      })
      .catch(() => {});
    void createRemoteCatalogCache
      .load(catalogKey, () => readCatalog(catalogKey, true), {
        maxAgeMs: GITHUB_READ_MAX_AGE_MS,
      })
      .catch(() => {});
    void createLocalBranchesCache
      .load(localKey, () => readLocalBranches(localKey), {
        maxAgeMs: GIT_READ_MAX_AGE_MS,
      })
      .catch(() => {});
  };
  const pick = (base: DispatcherBase) => {
    // Selecting the default restores the engine's fresh-default behavior.
    onChange(
      base.kind === "branch" && base.branch === defaultBase?.branch
        ? null
        : base,
    );
    setOpen(false);
  };
  const q = query.trim().toLowerCase();
  const localRows = branches.filter((b) => b.name.toLowerCase().includes(q));
  const remoteRows =
    catalog?.branchSource === "remote"
      ? catalog.branches.filter((b) => b.name.toLowerCase().includes(q))
      : [];
  const prs = (prsRead.data ?? NO_PRS).filter((p) =>
    `${p.title} ${p.headBranch} ${p.number}`.toLowerCase().includes(q),
  );
  const refreshing = branchesRead.refreshing || remoteRead.refreshing;
  const refresh = () => {
    branchesRead.refresh();
    catalogRead.refresh();
    remoteRead.refresh();
    if (activeTab === "prs") prsRead.refresh();
  };
  const sourceName =
    selected?.kind === "pr"
      ? "pull request"
      : selected?.source === "github"
        ? "GitHub branch"
        : selected?.source === "remote"
          ? "remote branch"
          : "local branch";

  return (
    <Popover
      open={active && !disabled && open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setQuery("");
          setTab(null);
        }
      }}
    >
      <Tooltip
        label={
          selected
            ? `Create from ${sourceName}: ${selected.label}`
            : "Create from source"
        }
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            disabled={!project || disabled}
            data-create-source-trigger=""
            onPointerEnter={warm}
            onFocus={warm}
            aria-label={
              selected
                ? `Create from ${sourceName}: ${selected.label}`
                : "Create from source"
            }
            className="group/source text-fg2 h-7 min-w-0 gap-1.5 px-2 text-sm font-normal hover:bg-transparent"
          >
            <SourceIcon base={selected} />
            <span className="max-w-[200px] truncate">
              {selected?.label ??
                (catalogRead.loading ? "Loading branches…" : "Choose branch")}
            </span>
            <ChevronDown className="text-fg2 size-3 shrink-0" />
          </Button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="flex w-[480px] flex-col overflow-hidden p-0"
        aria-label="Create from source"
      >
        <div className="border-border1 flex shrink-0 items-center gap-2 border-b px-3 py-2">
          <Search className="text-fg2 size-3.5 shrink-0" aria-hidden="true" />
          <input
            autoFocus
            type="search"
            aria-label="Search sources"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name"
            className="text-fg1 placeholder:text-fg3 min-w-0 flex-1 bg-transparent text-xs outline-none"
            spellCheck={false}
          />
          {project && (
            <span className="text-fg2 inline-flex min-w-0 items-center gap-1.5 text-xs">
              <RepositoryIcon
                project={project}
                className="size-4 shrink-0 rounded-sm"
              />
              <span className="max-w-[100px] truncate">{project.name}</span>
            </span>
          )}
          <Tooltip label="Refresh sources">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Refresh sources"
              onClick={refresh}
              disabled={refreshing}
            >
              <RefreshCw className="size-3.5" />
            </Button>
          </Tooltip>
        </div>
        <Tabs
          value={activeTab}
          onValueChange={(next) => setTab(next as Tab)}
          className="flex min-h-0 flex-col"
        >
          <TabsList
            aria-label="Source type"
            className="border-border1 h-auto w-full shrink-0 flex-wrap justify-start gap-0 rounded-none border-b bg-transparent p-1"
          >
            <TabsTrigger
              value="local"
              aria-label="Local branches"
              variant="chrome"
              className="gap-1.5"
            >
              <Laptop className="size-3.5" aria-hidden="true" />
              Branches
            </TabsTrigger>
            {remote && (
              <TabsTrigger
                value="remote"
                aria-label={
                  remote.isGitHub ? "GitHub branches" : "Remote branches"
                }
                variant="chrome"
                className="gap-1.5"
              >
                {remote.isGitHub ? (
                  <GithubIcon className="size-3.5" aria-hidden="true" />
                ) : (
                  <GitBranch className="size-3.5" aria-hidden="true" />
                )}
                Branches
              </TabsTrigger>
            )}
            <TabsTrigger value="prs" variant="chrome" disabled={!originUrl}>
              Pull requests
            </TabsTrigger>
            <Tooltip label="Coming soon">
              <TabsTrigger value="issues" variant="chrome" disabled>
                Issues
              </TabsTrigger>
            </Tooltip>
          </TabsList>
          <div className="min-h-0 overflow-y-auto overscroll-contain">
            <TabsContent value="local" className="m-0 max-h-[300px]">
              <ReadState
                loading={branchesRead.loading}
                error={!branchesRead.data ? branchesRead.error : null}
                onRetry={branchesRead.refresh}
              >
                <BaseList
                  rows={localRows.map((b) => {
                    const base = branchBase(b.name);
                    return {
                      base,
                      selected:
                        selected?.branch === base.branch &&
                        selected.kind === "branch",
                      secondary:
                        base.branch === defaultBase?.branch
                          ? "Default"
                          : undefined,
                      onClick: () => pick(base),
                    };
                  })}
                  emptyLabel={
                    q
                      ? "No local branches match your search."
                      : "No local branches yet."
                  }
                />
              </ReadState>
            </TabsContent>
            <TabsContent value="remote" className="m-0 max-h-[300px]">
              <ReadState
                loading={!catalog && catalogRead.loading}
                error={!catalog ? catalogRead.error : null}
                onRetry={refresh}
              >
                <BaseList
                  rows={remoteRows.map((b) => {
                    const base = branchBase(b.name, remote);
                    return {
                      base,
                      selected:
                        selected?.branch === base.branch &&
                        selected.kind === "branch",
                      secondary:
                        base.branch === defaultBase?.branch
                          ? "Default"
                          : remote?.name,
                      onClick: () => pick(base),
                    };
                  })}
                  emptyLabel={
                    q
                      ? "No remote branches match your search."
                      : remoteRead.loading
                        ? "Fetching remote branches…"
                        : "No remote branches available. Refresh to fetch branches."
                  }
                />
              </ReadState>
            </TabsContent>
            <TabsContent value="prs" className="m-0 max-h-[300px]">
              <ReadState
                loading={prsRead.loading}
                error={!prsRead.data ? prsRead.error : null}
                onRetry={prsRead.refresh}
              >
                <BaseList
                  rows={prs.map((p) => {
                    const base: DispatcherBase = {
                      kind: "pr",
                      branch:
                        remote &&
                        catalog?.branchSource === "remote" &&
                        catalog?.branches.some((b) => b.name === p.headBranch)
                          ? branchBase(p.headBranch, remote).branch
                          : p.headBranch,
                      label: `#${p.number} · ${p.title}`,
                      source: "github",
                      prNumber: p.number,
                      prUrl: p.url,
                    };
                    return {
                      base,
                      selected: selected?.prNumber === p.number,
                      secondary: p.headBranch,
                      onClick: () => pick(base),
                    };
                  })}
                  emptyLabel={
                    q
                      ? "No pull requests match your search."
                      : "No open pull requests on this repo."
                  }
                />
              </ReadState>
            </TabsContent>
          </div>
        </Tabs>
      </PopoverContent>
    </Popover>
  );
}

function SourceIcon({ base }: { base: DispatcherBase | null }) {
  const Icon =
    base?.kind === "pr"
      ? GitPullRequest
      : base?.source === "github"
        ? GithubIcon
        : base?.source === "remote"
          ? GitBranch
          : Laptop;
  return (
    <Icon
      className="text-fg2 group-hover/source:text-fg1 size-3.5 shrink-0"
      aria-hidden="true"
    />
  );
}
function ReadState({
  loading,
  error,
  onRetry,
  children,
}: {
  loading: boolean;
  error: Error | null;
  onRetry: () => void;
  children: React.ReactNode;
}) {
  if (loading)
    return (
      <div className="text-fg2 px-3 py-6 text-xs" role="status">
        Loading sources…
      </div>
    );
  if (error)
    return (
      <div className="flex flex-col items-start gap-2 px-3 py-4 text-xs">
        <span role="alert" className="text-red-primary">
          {error.message}
        </span>
        <Button type="button" variant="ghost" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  return children;
}
function BaseList({
  rows,
  emptyLabel,
}: {
  rows: {
    base: DispatcherBase;
    secondary?: string;
    selected: boolean;
    onClick: () => void;
  }[];
  emptyLabel: string;
}) {
  if (!rows.length)
    return (
      <div className="text-fg2 px-3 py-6 text-xs" role="status">
        {emptyLabel}
      </div>
    );
  return (
    <div
      className="flex flex-col p-1"
      onKeyDown={(event) => {
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
          return;
        const buttons = Array.from(
          event.currentTarget.querySelectorAll("button"),
        );
        const index = buttons.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : (index +
                  (event.key === "ArrowDown" ? 1 : -1) +
                  buttons.length) %
                buttons.length;
        event.preventDefault();
        buttons[next]?.focus();
      }}
    >
      {rows.map(({ base, secondary, selected, onClick }) => (
        <Button
          key={`${base.kind}:${base.prNumber ?? base.branch}`}
          type="button"
          variant="ghost"
          onClick={onClick}
          aria-pressed={selected}
          title={base.label}
          className="h-8 w-full min-w-0 justify-start gap-2 px-2 font-normal"
        >
          <SourceIcon base={base} />
          <span className="min-w-0 flex-1 truncate text-left">
            {base.label}
          </span>
          {secondary && (
            <span className="text-fg3 max-w-[130px] truncate text-xs">
              {secondary}
            </span>
          )}
          {selected && <Check className="text-fg2 size-3.5 shrink-0" />}
        </Button>
      ))}
    </div>
  );
}
