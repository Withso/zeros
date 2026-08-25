// ──────────────────────────────────────────────────────────
// CreateFromSource — the dispatcher's "Create from…" base picker
// ──────────────────────────────────────────────────────────
//
// A SELECT-a-base control, not an immediate-action picker: choosing a PR or
// branch only records it as the BASE the dispatcher's "Create" forks the new
// worktree off; the actual create happens on the Create button alongside the
// typed prompt. Default base (no selection) is the repo's default branch —
// a fresh workspace.
//
// Layout: search + repo badge, tabs (Pull requests / Branches / Issues),
// per-row select. Issues is parked behind "Coming soon" (no backend yet).
// ──────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  GitBranch,
  GitPullRequest,
  Search,
  X,
} from "lucide-react";

import { cn } from "../../shared/ui/cn";
import { Tooltip } from "@/renderer/shared/ui/primitives";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../shared/ui/primitives/popover";
import { Tabs, TabsList, TabsTrigger } from "../../shared/ui/primitives/tabs";
import {
  ghPrList,
  gitListAllBranches,
  isGitErrorShape,
  type Branch,
  type PR,
} from "../../platform/git";
import type { Project } from "../../state/projects-store";
import {
  allBranchesCache,
  GIT_READ_MAX_AGE_MS,
  GITHUB_READ_MAX_AGE_MS,
  openPrsCache,
} from "../../state/read-caches";
import { useCachedRead } from "../../state/use-cached-read";
import { RepositoryIcon } from "../../features/repositories/repository-icon";

const NO_BRANCHES: Branch[] = [];
const NO_PRS: PR[] = [];

/** A base the dispatcher will fork the new worktree off. `branch` is the ref
 *  passed to workspaceCreate as `baseBranch`. */
export interface DispatcherBase {
  kind: "branch" | "pr";
  branch: string;
  label: string;
  prNumber?: number;
  prUrl?: string;
}

interface CreateFromSourceProps {
  project: Project | null;
  value: DispatcherBase | null;
  onChange: (base: DispatcherBase | null) => void;
}

type Tab = "prs" | "branches" | "issues";

export function CreateFromSource({
  project,
  value,
  onChange,
}: CreateFromSourceProps) {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>("branches");
  const [query, setQuery] = useState("");

  // Cached branch + open-PR rows, shared process-wide by repo slug:
  // reopening paints the previous rows instantly; a background revalidation
  // runs only past the freshness window, never blanking what's on screen.
  const branchesRead = useCachedRead(
    allBranchesCache,
    open && project ? project.repoSlug : null,
    () =>
      project
        ? gitListAllBranches({
            repoSlug: project.repoSlug,
            repoRoot: project.repoRoot,
          }).catch((err: unknown) => {
            throw new Error(
              isGitErrorShape(err)
                ? err.message
                : err instanceof Error
                  ? err.message
                  : String(err),
            );
          })
        : Promise.resolve<Branch[]>([]),
    { maxAgeMs: GIT_READ_MAX_AGE_MS },
  );
  const prsRead = useCachedRead(
    openPrsCache,
    open && project?.originUrl ? project.originUrl : null,
    () =>
      project?.originUrl
        ? ghPrList({ originUrl: project.originUrl, state: "open" })
        : Promise.resolve<PR[]>([]),
    { maxAgeMs: GITHUB_READ_MAX_AGE_MS },
  );
  const branches = branchesRead.data ?? NO_BRANCHES;
  const prs = prsRead.data ?? NO_PRS;
  const loading = branchesRead.loading || prsRead.loading;
  // A PR-list failure degrades to branches-only (matching the old inline
  // .catch); only a branch-read failure with nothing cached is a visible error.
  const error =
    branchesRead.data === undefined
      ? (branchesRead.error?.message ?? null)
      : null;

  // Reset the search per open so yesterday's query doesn't filter today's rows.
  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  const filteredBranches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return branches;
    return branches.filter((b) => b.name.toLowerCase().includes(q));
  }, [branches, query]);

  const filteredPrs = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return prs;
    return prs.filter(
      (p) =>
        p.title.toLowerCase().includes(q) ||
        p.headBranch.toLowerCase().includes(q) ||
        String(p.number).includes(q),
    );
  }, [prs, query]);

  const pickBranch = useCallback(
    (b: Branch) => {
      onChange({ kind: "branch", branch: b.name, label: b.name });
      setOpen(false);
    },
    [onChange],
  );

  const pickPr = useCallback(
    (p: PR) => {
      onChange({
        kind: "pr",
        branch: p.headBranch,
        label: `#${p.number} · ${p.headBranch}`,
        prNumber: p.number,
        prUrl: p.url,
      });
      setOpen(false);
    },
    [onChange],
  );

  const disabled = !project;

  return (
    <div className="flex items-center gap-1">
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip label="Create from source">
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={disabled}
              className={cn(
                "text-fg2 inline-flex items-center gap-1.5 rounded-sm px-2 py-1 text-sm transition-colors",
                disabled
                  ? "cursor-not-allowed opacity-40"
                  : "hover:bg-bg2-hover hover:text-fg1",
              )}
            >
              {value ? (
                value.kind === "pr" ? (
                  <GitPullRequest size={13} className="shrink-0" />
                ) : (
                  <GitBranch size={13} className="shrink-0" />
                )
              ) : null}
              <span className="max-w-[160px] truncate">
                {value ? value.label : "Create from…"}
              </span>
              <ChevronDown size={12} className="text-fg2 opacity-70" />
            </button>
          </PopoverTrigger>
        </Tooltip>
        <PopoverContent
          align="end"
          sideOffset={6}
          className="w-[420px] overflow-hidden p-0"
        >
          {/* Search + repo label */}
          <div className="border-border1 flex items-center gap-2 border-b px-3 py-2.5">
            <Search className="text-fg2 size-3.5 shrink-0" />
            <input
              autoFocus
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name"
              className="text-fg1 placeholder:text-fg3 flex-1 bg-transparent text-xs outline-none"
              spellCheck={false}
            />
            {project && (
              <span className="text-fg2 inline-flex shrink-0 items-center gap-1.5 text-xs">
                <span className="bg-bg3-hover inline-flex size-4 items-center justify-center rounded-sm text-xs">
                  <RepositoryIcon
                    project={project}
                    className="size-full rounded-sm"
                  />
                </span>
                <span className="max-w-[120px] truncate">{project.name}</span>
              </span>
            )}
          </div>

          {/* Tabs */}
          <Tabs
            value={activeTab}
            onValueChange={(v) => setActiveTab(v as Tab)}
            className="border-border1 border-b"
          >
            <TabsList className="h-9 gap-0 rounded-none border-0 bg-transparent px-2">
              <TabsTrigger
                value="prs"
                className="data-[state=active]:text-fg1 h-7 rounded-md px-2.5 text-xs data-[state=active]:bg-transparent data-[state=active]:font-medium"
              >
                Pull requests
              </TabsTrigger>
              <TabsTrigger
                value="branches"
                className="data-[state=active]:text-fg1 h-7 rounded-md px-2.5 text-xs data-[state=active]:bg-transparent data-[state=active]:font-medium"
              >
                Branches
              </TabsTrigger>
              <Tooltip label="Coming soon">
                <TabsTrigger
                  value="issues"
                  disabled
                  className="h-7 cursor-not-allowed rounded-md px-2.5 text-xs opacity-50"
                >
                  Issues
                </TabsTrigger>
              </Tooltip>
            </TabsList>
          </Tabs>

          {/* Body */}
          <div className="max-h-[300px] overflow-y-auto">
            {loading && <div className="min-h-16" aria-busy="true" />}
            {!loading && error && (
              <div className="text-red-primary px-3 py-6 text-xs">{error}</div>
            )}
            {!loading && !error && activeTab === "branches" && (
              <BaseList
                rows={filteredBranches.map((b) => ({
                  key: b.name,
                  icon: <GitBranch className="text-fg2 size-3.5 shrink-0" />,
                  primary: b.name,
                  onClick: () => pickBranch(b),
                }))}
                emptyLabel="No branches match your search."
              />
            )}
            {!loading && !error && activeTab === "prs" && (
              <BaseList
                rows={filteredPrs.map((p) => ({
                  key: String(p.number),
                  icon: (
                    <GitPullRequest className="text-fg1 size-3.5 shrink-0" />
                  ),
                  primary: p.title,
                  secondary: `#${p.number} · ${p.headBranch}`,
                  onClick: () => pickPr(p),
                }))}
                emptyLabel="No open pull requests on this repo."
              />
            )}
          </div>
        </PopoverContent>
      </Popover>
      {value && (
        <Tooltip label="Clear base">
          <button
            type="button"
            onClick={() => onChange(null)}
            className="text-fg2 hover:bg-bg2-hover hover:text-fg1 inline-flex size-5 items-center justify-center rounded-sm transition-colors"
            aria-label="Clear base"
          >
            <X size={12} />
          </button>
        </Tooltip>
      )}
    </div>
  );
}

interface BaseRow {
  key: string;
  icon: React.ReactNode;
  primary: string;
  secondary?: string;
  onClick: () => void;
}

function BaseList({
  rows,
  emptyLabel,
}: {
  rows: BaseRow[];
  emptyLabel: string;
}) {
  if (rows.length === 0) {
    return <div className="text-fg2 px-3 py-6 text-xs">{emptyLabel}</div>;
  }
  return (
    <div className="flex flex-col">
      {rows.map((r) => (
        <button
          key={r.key}
          type="button"
          onClick={r.onClick}
          className="group/row hover:bg-bg3-hover border-border1 flex items-center gap-2 border-b px-3 py-2 text-left transition-[background-color] duration-120 ease-out last:border-b-0"
        >
          {r.icon}
          <span className="min-w-0 flex-1 truncate text-xs">{r.primary}</span>
          {r.secondary && (
            <span className="text-fg2 shrink-0 text-xs">{r.secondary}</span>
          )}
        </button>
      ))}
    </div>
  );
}
