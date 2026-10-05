import { useEffect, useState } from "react";
import { ChevronDown, RefreshCw, Search } from "lucide-react";
import type { CloudComputerV2ActiveRepository } from "@zeros/protocol/cloud-computer-v2";
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
  ghBranchList,
  ghPrList,
  isGitErrorShape,
  type GithubBranch,
} from "../../platform/git";
import {
  computerBranchesCache,
  computerPrsCache,
  GITHUB_READ_MAX_AGE_MS,
} from "../../state/read-caches";
import { useCachedRead } from "../../state/use-cached-read";
import { BaseList, ReadState, SourceIcon } from "./create-from-source";
import type { DispatcherBase } from "./dispatcher-source";

export function computerSourceReadKey(
  owner: string,
  repository: CloudComputerV2ActiveRepository,
): string {
  return JSON.stringify([
    ...(JSON.parse(owner) as [string, string]),
    repository.id,
    repository.owner,
    repository.name,
    repository.installationId,
  ]);
}
function repositoryForKey(key: string) {
  const [, , , owner, repo] = JSON.parse(key) as string[];
  return { owner, repo };
}
function readError(error: unknown) {
  return error instanceof Error
    ? error
    : new Error(isGitErrorShape(error) ? error.message : String(error));
}
export function readComputerBranches(key: string) {
  return ghBranchList(repositoryForKey(key)).catch((error: unknown) => {
    throw readError(error);
  });
}
export function readComputerPrs(key: string) {
  return ghPrList({ ...repositoryForKey(key), state: "open" }).catch(
    (error: unknown) => {
      throw readError(error);
    },
  );
}
export function warmComputerSources(key: string): void {
  void computerBranchesCache
    .load(key, () => readComputerBranches(key), {
      maxAgeMs: GITHUB_READ_MAX_AGE_MS,
    })
    .catch(() => {});
  void computerPrsCache
    .load(key, () => readComputerPrs(key), { maxAgeMs: GITHUB_READ_MAX_AGE_MS })
    .catch(() => {});
}
export function computerBranchBase(name: string): DispatcherBase {
  return {
    kind: "branch",
    branch: `refs/heads/${name}`,
    label: name,
    source: "github",
  };
}
const EMPTY_BRANCHES: GithubBranch[] = [];
const EMPTY_REMOTE_BASE = computerBranchBase("");
export function computerBranchRows(
  rows: GithubBranch[],
  defaultBranch: string | null,
): GithubBranch[] {
  return defaultBranch && !rows.some((row) => row.name === defaultBranch)
    ? [{ name: defaultBranch, isDefault: true }, ...rows.slice(0, 99)]
    : rows;
}

export function CloudComputerSourcePicker({
  readKey,
  repository,
  defaultBranch,
  value,
  onChange,
  active,
  disabled,
}: {
  readKey: string | null;
  repository: CloudComputerV2ActiveRepository | null;
  defaultBranch: string | null;
  value: DispatcherBase | null;
  onChange: (base: DispatcherBase | null) => void;
  active: boolean;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState("branches");
  const [query, setQuery] = useState("");
  const branches = useCachedRead(
    computerBranchesCache,
    readKey,
    readComputerBranches,
    { enabled: active, maxAgeMs: GITHUB_READ_MAX_AGE_MS },
  );
  const prs = useCachedRead(computerPrsCache, readKey, readComputerPrs, {
    enabled: active && open && tab === "prs",
    maxAgeMs: GITHUB_READ_MAX_AGE_MS,
  });
  useEffect(() => {
    if (!active || disabled) setOpen(false);
  }, [active, disabled]);
  const selected =
    value ?? (defaultBranch ? computerBranchBase(defaultBranch) : null);
  const warm = () => {
    if (active && !disabled && readKey) warmComputerSources(readKey);
  };
  const q = query.trim().toLowerCase();
  const branchRows = computerBranchRows(
    branches.data ?? EMPTY_BRANCHES,
    defaultBranch,
  ).filter((row) => row.name.toLowerCase().includes(q));
  const prRows = (prs.data ?? []).filter((row) =>
    `${row.title} ${row.headBranch} ${row.number}`.toLowerCase().includes(q),
  );
  const pick = (base: DispatcherBase) => {
    onChange(
      base.kind === "branch" && base.label === defaultBranch ? null : base,
    );
    setOpen(false);
  };
  return (
    <Popover
      open={active && !disabled && open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setQuery("");
          setTab(value?.kind === "pr" ? "prs" : "branches");
        }
      }}
    >
      <Tooltip
        label={
          selected
            ? `Create from ${selected.kind === "pr" ? "pull request" : "GitHub branch"}: ${selected.label}`
            : "Create from source"
        }
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            data-create-source-trigger=""
            disabled={!repository || disabled}
            aria-label={
              selected
                ? `Create from ${selected.kind === "pr" ? "pull request" : "GitHub branch"}: ${selected.label}`
                : "Create from source"
            }
            onPointerEnter={warm}
            onFocus={warm}
            className="group/source text-fg2 h-7 min-w-0 gap-1.5 px-2 text-sm font-normal hover:bg-transparent"
          >
            <SourceIcon base={selected ?? EMPTY_REMOTE_BASE} />
            <span className="max-w-[200px] truncate">
              {selected?.label ?? "Choose branch"}
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
            type="search"
            aria-label="Search sources"
            placeholder="Search by name"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            spellCheck={false}
            className="text-fg1 placeholder:text-fg3 min-w-0 flex-1 bg-transparent text-xs outline-none"
          />
          <span className="text-fg2 inline-flex min-w-0 items-center gap-1.5 text-xs">
            <GithubIcon className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="max-w-[100px] truncate">{repository?.name}</span>
          </span>
          <Tooltip label="Refresh sources">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Refresh sources"
              disabled={branches.refreshing || prs.refreshing}
              onClick={() => {
                branches.refresh();
                if (tab === "prs") prs.refresh();
              }}
            >
              <RefreshCw className="size-3.5" />
            </Button>
          </Tooltip>
        </div>
        <Tabs
          value={tab}
          onValueChange={setTab}
          className="flex min-h-0 flex-col"
        >
          <TabsList
            aria-label="Source type"
            className="border-border1 h-auto w-full shrink-0 flex-wrap justify-start gap-0 rounded-none border-b bg-transparent p-1"
          >
            <TabsTrigger
              value="branches"
              aria-label="Branches"
              variant="chrome"
              className="gap-1.5"
            >
              <GithubIcon className="size-3.5" aria-hidden="true" />
              Branches
            </TabsTrigger>
            <TabsTrigger value="prs" variant="chrome">
              Pull requests
            </TabsTrigger>
          </TabsList>
          <div className="min-h-0 overflow-y-auto overscroll-contain">
            <TabsContent value="branches" className="m-0 max-h-[300px]">
              {branches.data && branches.error && (
                <p className="text-fg3 px-3 py-2 text-xs" role="status">
                  {branches.error.message}
                </p>
              )}
              <ReadState
                loading={branches.loading && branchRows.length === 0}
                error={!branches.data ? branches.error : null}
                onRetry={branches.refresh}
              >
                <BaseList
                  rows={branchRows.map((row) => ({
                    base: computerBranchBase(row.name),
                    selected:
                      selected?.kind === "branch" &&
                      selected.branch === `refs/heads/${row.name}`,
                    secondary:
                      row.name === defaultBranch ? "Default" : undefined,
                    onClick: () => pick(computerBranchBase(row.name)),
                  }))}
                  emptyLabel={
                    q
                      ? "No remote branches match your search."
                      : "No remote branches available."
                  }
                />
              </ReadState>
            </TabsContent>
            <TabsContent value="prs" className="m-0 max-h-[300px]">
              {prs.data && prs.error && (
                <p className="text-fg3 px-3 py-2 text-xs" role="status">
                  {prs.error.message}
                </p>
              )}
              <ReadState
                loading={prs.loading}
                error={!prs.data ? prs.error : null}
                onRetry={prs.refresh}
              >
                <BaseList
                  rows={prRows.map((row) => {
                    const base: DispatcherBase = {
                      kind: "pr",
                      branch: `refs/pull/${row.number}/head`,
                      label: `#${row.number} · ${row.title}`,
                      source: "github",
                      prNumber: row.number,
                      prUrl: row.url,
                    };
                    return {
                      base,
                      selected: selected?.prNumber === row.number,
                      secondary: row.headBranch,
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
