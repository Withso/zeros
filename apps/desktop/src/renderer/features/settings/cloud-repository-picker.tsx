import { useWorkspaceDispatch } from "../../state/store";
import { useState } from "react";
import { Check, ChevronDown, RefreshCw } from "lucide-react";
import type { CloudGithubRepositoryPage } from "@zeros/protocol/cloud-github-connection";
import { Button, GithubIcon, Input } from "../../shared/ui";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../shared/ui/primitives/popover";
import { useRecoveringRead } from "../../state/use-recovering-read";
import {
  cloudGithubConnectionCache,
  cloudGithubRepositoryPageCache,
  cloudGithubConnectionKey,
  readCloudGithubConnection,
  readSelectedCloudRepositories,
} from "../../platform/cloud-github-connection";
import { requestUserSettingsSection } from "./settings-navigation";
import { cloudGithubHealthCopy } from "./cloud-github-health";

export type CloudRepositorySelection =
  CloudGithubRepositoryPage["repositories"][number];
const matches = (a: CloudRepositorySelection, b: CloudRepositorySelection) =>
  a.id === b.id;
/** A repository chosen by its owner/name, which outlives a GitHub selection. */
export type CloudRepositoryName = { owner: string; name: string };
export function CloudRepositoryPicker({
  userId,
  organizationId,
  value = [],
  onChange,
  isSelected,
  onToggle,
  label,
  multiple = false,
  disabled = false,
  active = true,
  onManageConnections,
}: {
  userId: string;
  organizationId: string;
  value?: readonly CloudRepositorySelection[];
  onChange?(value: CloudRepositorySelection[]): void;
  /** Name-based selection for lists stored by owner/name (Cloud Computer). */
  isSelected?(repository: CloudRepositoryName): boolean;
  onToggle?(repository: CloudRepositorySelection): void;
  /** Trigger text; defaults to the selection count or name. */
  label?: string;
  multiple?: boolean;
  disabled?: boolean;
  active?: boolean;
  onManageConnections?: () => void;
}) {
  const dispatch = useWorkspaceDispatch();
  const [open, setOpen] = useState(false);
  const scope = cloudGithubConnectionKey(userId, organizationId);
  const catalog = useRecoveringRead(
    cloudGithubConnectionCache,
    scope,
    (key) => {
      const [user, org] = JSON.parse(key) as [string, string];
      return readCloudGithubConnection(user, org);
    },
    { enabled: active && open, maxAgeMs: 60_000 },
  );
  const selectedMethod = catalog.data?.selectedMethod;
  const connected =
    !!selectedMethod &&
    catalog.data?.methods[selectedMethod].health === "connected";
  const selected = (repository: CloudRepositorySelection) =>
    isSelected
      ? isSelected(repository)
      : value.some((row) => matches(row, repository));
  const select = (repository: CloudRepositorySelection) => {
    if (onToggle) {
      onToggle(repository);
      if (!multiple) setOpen(false);
    } else if (multiple)
      onChange?.(
        value.some((row) => matches(row, repository))
          ? value.filter((row) => !matches(row, repository))
          : [...value, repository],
      );
    else {
      onChange?.([repository]);
      setOpen(false);
    }
  };
  return (
    <Popover open={active && open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="secondary"
          className="w-full justify-between"
          disabled={disabled}
          aria-label="Choose cloud repositories"
        >
          <span className="truncate">
            {label ??
              (multiple
                ? `${value.length} repositories selected`
                : value[0]
                  ? `${value[0].owner}/${value[0].name}`
                  : "Choose repository")}
          </span>
          <ChevronDown className="size-3.5 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[420px] max-w-[calc(100vw-32px)] p-3"
      >
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-fg1 text-sm font-medium">Repositories</span>
            <Button
              variant="ghost"
              aria-label="Refresh GitHub repository connections"
              onClick={catalog.refresh}
            >
              <RefreshCw className="size-3.5" />
            </Button>
          </div>
          {catalog.error && (
            <p className="text-red-primary text-xs" role="alert">
              {catalog.error.message}
            </p>
          )}
          {catalog.loading && (
            <p className="text-fg2 text-xs" role="status">
              Loading GitHub connections…
            </p>
          )}
          {connected && catalog.data && (
            <RepositoryPage
              key={`${scope}:${catalog.data.generation}`}
              userId={userId}
              organizationId={organizationId}
              generation={catalog.data.generation}
              isSelected={selected}
              onSelect={select}
              active={active && open}
            />
          )}
          {!catalog.loading && !connected && (
            <p className="text-fg2 text-xs">
              {
                cloudGithubHealthCopy[
                  selectedMethod && catalog.data
                    ? catalog.data.methods[selectedMethod].health
                    : "not-connected"
                ]
              }
            </p>
          )}
          <Button
            variant="ghost"
            onClick={() => {
              setOpen(false);
              requestUserSettingsSection("integrations");
              onManageConnections?.();
              dispatch({ type: "SET_ACTIVE_PAGE", page: "settings" });
            }}
          >
            Manage GitHub connections
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
function RepositoryPage({
  userId,
  organizationId,
  generation,
  isSelected,
  onSelect,
  active,
}: {
  userId: string;
  organizationId: string;
  generation: string;
  isSelected(value: CloudRepositorySelection): boolean;
  onSelect(value: CloudRepositorySelection): void;
  active: boolean;
}) {
  const [page, setPage] = useState(1),
    [query, setQuery] = useState("");
  const key = JSON.stringify([
    cloudGithubConnectionKey(userId, organizationId),
    generation,
    page,
  ]);
  const result = useRecoveringRead(
    cloudGithubRepositoryPageCache,
    key,
    (key) => {
      const [scope, generation, page] = JSON.parse(key) as [
        string,
        string,
        number,
      ];
      const [user, org] = JSON.parse(scope) as [string, string];
      return readSelectedCloudRepositories(user, org, generation, page);
    },
    { enabled: active, maxAgeMs: 60_000 },
  );
  const repositories =
    result.data?.repositories.filter((row) =>
      `${row.owner}/${row.name}`.toLowerCase().includes(query.toLowerCase()),
    ) ?? [];
  return (
    <>
      <Input
        aria-label="Search repositories on this page"
        placeholder="Search repositories on this page…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {result.error && (
        <div className="flex flex-col gap-2">
          <p className="text-red-primary text-xs" role="alert">
            {result.error.message}
          </p>
          <Button variant="ghost" onClick={result.refresh}>
            Retry
          </Button>
        </div>
      )}
      {result.loading && (
        <p className="text-fg2 text-xs" role="status">
          Loading repositories…
        </p>
      )}
      <div
        className="flex max-h-64 flex-col gap-1 overflow-y-auto"
        aria-label="GitHub repositories"
      >
        {repositories.map((row) => {
          const candidate = row,
            selected = isSelected(candidate);
          return (
            <Button
              key={row.id}
              variant="ghost"
              className="w-full justify-start"
              aria-pressed={selected}
              onClick={() => onSelect(candidate)}
            >
              <GithubIcon className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate text-left">
                {row.owner}/{row.name}
              </span>
              {!row.canPush && (
                <span className="text-fg2 text-xs">Read only</span>
              )}
              {selected && <Check className="size-3.5 shrink-0" />}
            </Button>
          );
        })}
        {result.data && !repositories.length && (
          <p className="text-fg2 py-2 text-xs">
            No matching repositories on this page.
          </p>
        )}
      </div>
      {(page > 1 || result.data?.nextPage) && (
        <div className="flex items-center justify-between gap-2">
          <Button
            variant="ghost"
            disabled={page === 1}
            onClick={() => setPage((value) => value - 1)}
          >
            Previous
          </Button>
          <span className="text-fg2 text-xs">Page {page}</span>
          <Button
            variant="ghost"
            disabled={!result.data?.nextPage}
            onClick={() => setPage(result.data!.nextPage!)}
          >
            Next
          </Button>
        </div>
      )}
    </>
  );
}
