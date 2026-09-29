import { useWorkspaceDispatch } from "../../state/store";
import { useState } from "react";
import { Check, ChevronDown, RefreshCw } from "lucide-react";
import type { CloudGithubRepository } from "@zeros/protocol/github-auth";
import { Button, GithubIcon, Input } from "../../shared/ui";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../shared/ui/primitives/popover";
import { useCachedRead } from "../../state/use-cached-read";
import {
  cloudGithubCatalogCache,
  cloudGithubRepositoriesCache,
  cloudGithubScopeKey,
  readCloudGithubCatalog,
  readCloudGithubRepositories,
} from "../../platform/cloud-github";
import { requestUserSettingsSection } from "./settings-navigation";

export type CloudRepositorySelection = CloudGithubRepository & {
  installationId: string;
};
const matches = (a: CloudRepositorySelection, b: CloudRepositorySelection) =>
  a.id === b.id;
export function CloudRepositoryPicker({
  userId,
  organizationId,
  value,
  onChange,
  multiple = false,
  disabled = false,
  active = true,
  onManageConnections,
}: {
  userId: string;
  organizationId: string;
  value: readonly CloudRepositorySelection[];
  onChange(value: CloudRepositorySelection[]): void;
  multiple?: boolean;
  disabled?: boolean;
  active?: boolean;
  onManageConnections?: () => void;
}) {
  const dispatch = useWorkspaceDispatch();
  const [open, setOpen] = useState(false),
    [installationId, setInstallationId] = useState<string | null>(null);
  const scope = cloudGithubScopeKey(userId, organizationId);
  const catalog = useCachedRead(
    cloudGithubCatalogCache,
    scope,
    (key) => readCloudGithubCatalog((JSON.parse(key) as string[])[1]!),
    { enabled: active && open, maxAgeMs: 60_000 },
  );
  const connected =
    catalog.data?.installations.filter(
      (row) => row.connected && !row.suspendedAt,
    ) ?? [];
  const installation =
    connected.find((row) => row.id === installationId) ?? connected[0];
  const select = (repository: CloudRepositorySelection) => {
    if (multiple)
      onChange(
        value.some((row) => matches(row, repository))
          ? value.filter((row) => !matches(row, repository))
          : [...value, repository],
      );
    else {
      onChange([repository]);
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
            {multiple
              ? `${value.length} repositories selected`
              : value[0]
                ? `${value[0].owner}/${value[0].name}`
                : "Choose repository"}
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
            <p className="text-error text-xs" role="alert">
              {catalog.error.message}
            </p>
          )}
          {catalog.loading && (
            <p className="text-fg2 text-xs" role="status">
              Loading GitHub connections…
            </p>
          )}
          {connected.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {connected.map((row) => (
                <Button
                  key={row.id}
                  variant={installation?.id === row.id ? "secondary" : "ghost"}
                  aria-pressed={installation?.id === row.id}
                  onClick={() => setInstallationId(row.id)}
                >
                  {row.accountLogin}
                </Button>
              ))}
            </div>
          )}
          {installation && (
            <RepositoryPage
              key={`${scope}:${installation.id}`}
              userId={userId}
              organizationId={organizationId}
              installationId={installation.id}
              value={value}
              onSelect={select}
              active={active && open}
            />
          )}
          {!catalog.loading && !connected.length && (
            <p className="text-fg2 text-xs">
              Connect your GitHub account or organization to choose a
              repository.
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
  installationId,
  value,
  onSelect,
  active,
}: {
  userId: string;
  organizationId: string;
  installationId: string;
  value: readonly CloudRepositorySelection[];
  onSelect(value: CloudRepositorySelection): void;
  active: boolean;
}) {
  const [page, setPage] = useState(1),
    [query, setQuery] = useState("");
  const key = JSON.stringify([userId, organizationId, installationId, page]);
  const result = useCachedRead(
    cloudGithubRepositoriesCache,
    key,
    (key) => {
      const [, org, installation, page] = JSON.parse(key) as [
        string,
        string,
        string,
        number,
      ];
      return readCloudGithubRepositories(org, installation, page);
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
          <p className="text-error text-xs" role="alert">
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
          const candidate = { ...row, installationId },
            selected = value.some((item) => matches(item, candidate));
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
