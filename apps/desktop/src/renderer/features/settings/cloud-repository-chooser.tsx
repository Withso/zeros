// The Cloud Computer's repository choice, as Local's: who is signed in to
// GitHub, every repository the selected connection can clone grouped by owner,
// and Connect organization, which adds an owner on GitHub's installation page.
import { useEffect, useMemo, useState } from "react";
import { ChevronDown, RefreshCw } from "lucide-react";
import { Button, GithubIcon, Input } from "../../shared/ui";
import { Badge, Checkbox, IconButton } from "../../shared/ui/primitives";
import { Popover, PopoverContent, PopoverTrigger } from "../../shared/ui/primitives/popover";
import { useRecoveringRead } from "../../state/use-recovering-read";
import { useWorkspaceDispatch } from "../../state/store";
import { shellOpenUrl } from "../../platform/app";
import {
  beginCloudGithubConnection,
  cloudGithubConnectionCache,
  cloudGithubConnectionKey,
  cloudGithubRepositoryPageCache,
  readCloudGithubConnection,
  readSelectedCloudRepositories,
} from "../../platform/cloud-github-connection";
import { cloudGithubHealthCopy } from "./cloud-github-health";
import { requestUserSettingsSection } from "./settings-navigation";
import { chooserRows, fullName, repositoryOwners, type ChooserRepository } from "./cloud-repository-chooser-model";
import { useFocusRefresh } from "./use-focus-refresh";

const PAGE_LIMIT = 10;
const CONNECT_WAIT_MS = 10 * 60_000;

/** Every page the selected connection lists, read in order under one key. */
async function readAllRepositories(userId: string, organizationId: string, generation: string) {
  const repositories: ChooserRepository[] = [];
  for (let page = 1; page <= PAGE_LIMIT; page++) {
    const result = await readSelectedCloudRepositories(userId, organizationId, generation, page);
    repositories.push(...result.repositories);
    if (!result.nextPage) return { generation, repositories, nextPage: null, complete: result.complete };
  }
  return { generation, repositories, nextPage: null, complete: false };
}

export function CloudRepositoryChooser({ userId, organizationId, active, disabled, chosenCount, isChosen, onToggle, onChooseAll }: {
  userId: string;
  organizationId: string;
  active: boolean;
  disabled: boolean;
  chosenCount: number;
  isChosen(repository: { owner: string; name: string }): boolean;
  onToggle(repository: ChooserRepository): void;
  /** Chooses every listed repository, or clears them when all are chosen. */
  onChooseAll(repositories: ChooserRepository[], choose: boolean): void;
}) {
  const dispatch = useWorkspaceDispatch();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [owner, setOwner] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<{ generation: string; until: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scope = cloudGithubConnectionKey(userId, organizationId);
  const connection = useRecoveringRead(cloudGithubConnectionCache, scope, (key) => {
    const [user, org] = JSON.parse(key) as [string, string];
    return readCloudGithubConnection(user, org);
  }, { enabled: active, maxAgeMs: 60_000 });
  const method = connection.data?.selectedMethod;
  const summary = method ? connection.data?.methods[method] : undefined;
  const connected = summary?.health === "connected";
  const generation = connection.data?.generation;
  const listing = useRecoveringRead(cloudGithubRepositoryPageCache,
    connected && generation ? JSON.stringify([scope, generation, "all"]) : null,
    (key) => {
      const [owner, generation] = JSON.parse(key) as [string, string];
      const [user, org] = JSON.parse(owner) as [string, string];
      return readAllRepositories(user, org, generation);
    }, { enabled: active && open, maxAgeMs: 60_000 });
  const repositories = useMemo(() => listing.data?.repositories ?? [], [listing.data]);
  const owners = useMemo(() => repositoryOwners(repositories, isChosen), [repositories, isChosen]);
  const shownOwner = owner ?? owners.find((row) => row.chosen > 0)?.owner ?? owners[0]?.owner ?? null;
  const rows = chooserRows(repositories, query, shownOwner);
  const allChosen = rows.length > 0 && rows.every(isChosen);

  // GitHub's installation page reports back through the connection's
  // generation; poll only while this chooser waits on it.
  // R1: re-read when the person comes back from GitHub (focus), else every 60 s; stop at the deadline.
  useFocusRefresh(active && !!connecting, () => {
    if (!connecting || Date.now() >= connecting.until) return;
    void cloudGithubConnectionCache.load(scope, () => readCloudGithubConnection(userId, organizationId), { maxAgeMs: 0 }).catch(() => {});
  });
  useEffect(() => {
    if (!active || !connecting) return;
    const timer = window.setTimeout(() => setConnecting(null), Math.max(0, connecting.until - Date.now()));
    return () => window.clearTimeout(timer);
  }, [active, connecting]);
  useEffect(() => {
    if (connecting && generation && generation !== connecting.generation) setConnecting(null);
  }, [connecting, generation]);

  const connectOrganization = async () => {
    if (!generation) return;
    setError(null);
    try {
      const started = await beginCloudGithubConnection(userId, organizationId, generation, true);
      setConnecting({ generation: started.generation, until: Date.now() + CONNECT_WAIT_MS });
      await shellOpenUrl(started.url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "GitHub could not be opened. Try again.");
    }
  };
  const manageConnections = () => {
    setOpen(false);
    requestUserSettingsSection("integrations");
    dispatch({ type: "SET_ACTIVE_PAGE", page: "settings" });
  };

  return (
    <div className="flex flex-col gap-3">
      {connected && summary?.login && (
        <p className="text-fg2 m-0 flex items-center gap-2 text-xs">
          <GithubIcon className="size-3.5 shrink-0" aria-hidden />
          <span>Signed in to GitHub as <span className="text-fg1 font-medium">{summary.login}</span></span>
        </p>
      )}
      <Popover open={active && open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="secondary" className="w-full justify-between" disabled={disabled}>
            <span className="truncate">{chosenCount === 1 ? "1 repository selected" : `${chosenCount} repositories selected`}</span>
            <ChevronDown className="size-3.5 shrink-0" aria-hidden />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-140 max-w-[calc(100vw-32px)] p-0">
          <div className="flex items-center gap-2 p-3">
            <Input aria-label="Search repositories or paste a GitHub URL" placeholder="Search repositories or paste a GitHub URL"
              value={query} onChange={(event) => setQuery(event.target.value)} />
            <IconButton size="standard" label="Refresh repositories" onClick={() => { connection.refresh(); listing.refresh(); }}>
              <RefreshCw aria-hidden />
            </IconButton>
          </div>
          {!connected ? (
            <div className="border-border2 flex flex-col items-start gap-2 border-t p-3">
              <p className="text-fg2 m-0 text-xs">
                {connection.loading ? "Loading GitHub connections…" : cloudGithubHealthCopy[summary?.health ?? "not-connected"]}
              </p>
              <Button variant="ghost" onClick={manageConnections}>Manage GitHub connections</Button>
            </div>
          ) : (
            <div className="border-border2 flex h-80 border-t">
              <div className="border-border2 flex w-48 shrink-0 flex-col border-r">
                <span className="text-fg3 px-3 pt-3 pb-1 text-3xxs font-medium">Organizations</span>
                <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1" aria-label="Repository owners">
                  {owners.map((row) => (
                    <Button key={row.owner} variant="ghost" className="w-full justify-between" aria-pressed={!query && row.owner === shownOwner}
                      onClick={() => { setQuery(""); setOwner(row.owner); }}>
                      <span className="truncate">{row.owner}</span>
                      {row.chosen > 0 && <Badge>{row.chosen}</Badge>}
                    </Button>
                  ))}
                </div>
                <div className="border-border2 border-t p-1">
                  <Button variant="ghost" className="w-full justify-start" disabled={!!connecting} onClick={() => void connectOrganization()}>
                    <GithubIcon className="size-3.5 shrink-0" aria-hidden />
                    {connecting ? "Finish on GitHub…" : "Connect organization"}
                  </Button>
                </div>
              </div>
              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex items-center justify-between gap-2 px-3 pt-2">
                  <span className="text-fg3 text-3xxs font-medium">{rows.length === 1 ? "1 repository" : `${rows.length} repositories`}</span>
                  {rows.length > 0 && (
                    <Button variant="ghost" size="compact" onClick={() => onChooseAll(rows, !allChosen)}>
                      {allChosen ? "Clear all" : "Select all"}
                    </Button>
                  )}
                </div>
                <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-3 py-2" aria-label="GitHub repositories">
                  {listing.loading && !listing.data && <p className="text-fg2 m-0 text-xs" role="status">Loading repositories…</p>}
                  {listing.error && <p className="text-red-primary m-0 text-xs" role="alert">{listing.error.message}</p>}
                  {error && <p className="text-red-primary m-0 text-xs" role="alert">{error}</p>}
                  {rows.map((row) => (
                    <Checkbox key={row.id} checked={isChosen(row)} onChange={() => onToggle(row)}
                      label={query ? fullName(row) : row.name} hint={row.canPush ? undefined : "Read only"} />
                  ))}
                  {listing.data && rows.length === 0 && (
                    <p className="text-fg2 m-0 text-xs">
                      {query ? "No repository matches. Use Connect organization to grant Zeros access." : "No repositories yet."}
                    </p>
                  )}
                  {listing.data && !listing.data.complete && (
                    <p className="text-fg3 m-0 text-3xxs">Showing the first {PAGE_LIMIT * 100} repositories. Search to narrow the list.</p>
                  )}
                </div>
              </div>
            </div>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}
