// Cloud Computer for cloud workspace v2. An organization owner or admin keeps
// the repositories to install and their setup as an organization setting; a
// build makes them the organization's one live snapshot. New cloud
// workspaces fork it with the repositories already installed. Repositories
// stay until an admin removes them, and every edit waits for the next build.
// Older builds stay in the history and can be made active again, which
// rebuilds them at the same commits.
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, CircleCheck, CircleMinus, CircleX, LoaderCircle, TriangleAlert, X } from "lucide-react";
import { Button, GithubIcon, Input } from "../../shared/ui";
import { Badge, CodeTextarea } from "../../shared/ui/primitives";
import { KeyedAsyncCache } from "../../shared/lib/keyed-async-cache";
import { useRecoveringRead } from "../../state/use-recovering-read";
import { useActiveOrganization, useTeams } from "../team/team-store";
import { ControlPlaneError } from "../team/control-plane";
import { SettingsGroup, SettingsSection } from "./settings-ui";
import { CloudRepositoryPicker, type CloudRepositorySelection } from "./cloud-repository-picker";
import {
  activateCloudV2Build, buildCloudV2Computer, buildConfiguredCloudV2Computer, discardCloudV2ComputerRecipe,
  getCloudV2Computer, saveCloudV2ComputerRecipe, type CloudV2Build, type CloudV2Computer, type CloudV2RepositoryDraft,
} from "../../platform/cloud-v2";
import { computerChanges, computerStatus, editableRepositories, historyNote, newerRecipe, RecipeSaveQueue, relativeAge, type ComputerStatus } from "./cloud-computer-model";

const computers = new KeyedAsyncCache<CloudV2Computer>({ maxEntries: 16 });
const MAX_REPOSITORIES = 10;
/** Typing in a branch or setup field saves after a pause; list edits at once. */
const TYPING_SAVE_MS = 600;

const computerKey = (userId: string, organizationId: string) => JSON.stringify([userId, organizationId]);
/** Intent warming for the Settings entry; only owners and admins can read it. */
export function prefetchCloudComputer(userId: string, organization: { id: string; isPersonal: boolean; role?: string }): void {
  if (organization.isPersonal || (organization.role !== "owner" && organization.role !== "admin")) return;
  void computers.load(computerKey(userId, organization.id), () => getCloudV2Computer(organization.id), { maxAgeMs: 30_000 })
    .catch(() => undefined);
}

function message(error: unknown): string {
  if (error instanceof ControlPlaneError) return error.message;
  return "The Cloud Computer request failed. Try again.";
}

export function CloudComputerPanel({ surfaceActive = true }: { surfaceActive?: boolean }) {
  const organization = useActiveOrganization();
  const { me } = useTeams();
  if (!organization || organization.isPersonal || !me) return null;
  const canManage = organization.role === "owner" || organization.role === "admin";
  return <CloudComputerScope key={`${me.user.id}:${organization.id}`} userId={me.user.id}
    organizationId={organization.id} canManage={canManage} active={surfaceActive} />;
}

/** Merges a recipe reply into the freshest cached overview. A late reply
 * never replaces a newer revision a refresh has already shown. */
function publishRecipe(key: string, latest: { current: { data: CloudV2Computer | undefined; revision: number | undefined } },
  saved: { recipe: NonNullable<CloudV2Computer["recipe"]>; recipeRevision: number }): void {
  const next = newerRecipe(computers.getSnapshot(key).data ?? latest.current.data, saved);
  if (!next) return;
  latest.current = { data: next, revision: saved.recipeRevision };
  computers.setData(key, next);
}

/** Local edits over the configured repositories, saved in order at the
 * revision they started from. A newer revision from elsewhere wins. */
function useRecipeDraft(organizationId: string, key: string, data: CloudV2Computer | undefined,
  refresh: () => void, onError: (text: string) => void) {
  const [local, setLocal] = useState<CloudV2RepositoryDraft[] | null>(null);
  const legacy = data !== undefined && data.recipeRevision === undefined;
  const latest = useRef({ data, revision: data?.recipeRevision });
  latest.current = { data, revision: data?.recipeRevision };
  const callbacks = useRef({ refresh, onError });
  callbacks.current = { refresh, onError };
  const [queue] = useState(() => new RecipeSaveQueue<CloudV2RepositoryDraft[]>({
    save: async (repositories, revision) => {
      const saved = await saveCloudV2ComputerRecipe(organizationId, repositories, revision);
      publishRecipe(key, latest, saved);
      return saved.recipeRevision;
    },
    serverRevision: () => latest.current.revision,
    onSaved: () => setLocal(null),
    onError: error => {
      setLocal(null); callbacks.current.refresh();
      callbacks.current.onError(error instanceof ControlPlaneError && error.code === "computer_recipe_changed"
        ? "The Cloud Computer changed elsewhere. The latest repositories are shown." : message(error));
    },
  }));
  // Leaving with a pending pause still saves it.
  useEffect(() => () => { if (queue.waiting) void queue.flush(); }, [queue]);

  const edit = useCallback((next: CloudV2RepositoryDraft[], delayMs: number) => {
    setLocal(next);
    if (!legacy) queue.push(next, delayMs);
  }, [legacy, queue]);
  const reset = useCallback(() => { queue.cancel(); setLocal(null); }, [queue]);
  return { local, legacy, edit, settle: () => queue.settle(), revision: () => queue.revision(), reset, latest };
}

function CloudComputerScope({ userId, organizationId, canManage, active }: {
  userId: string; organizationId: string; canManage: boolean; active: boolean;
}) {
  const key = computerKey(userId, organizationId);
  const computer = useRecoveringRead(computers, canManage ? key : null, () => getCloudV2Computer(organizationId),
    { enabled: active, maxAgeMs: 30_000 });
  const data = computer.data;
  const builds = data?.builds ?? [];
  const latestBuild = builds[0];
  const running = latestBuild?.state === "queued" || latestBuild?.state === "building";
  const refresh = computer.refresh;
  useEffect(() => {
    if (!active || !running) return;
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [active, running, refresh]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const draft = useRecipeDraft(organizationId, key, data, refresh, setError);

  const activeBuild = builds.find(build => build.id === data?.activeBuildId);
  const live = editableRepositories(activeBuild);
  const configured = draft.local ?? data?.recipe?.repositories ?? live;
  const changes = computerChanges(configured, live);
  const status = computerStatus({ builds, activeBuildId: data?.activeBuildId ?? null, changes,
    configuredCount: configured.length, now: Date.now(), loaded: data !== undefined });
  const liveBranch = (repository: string) =>
    activeBuild?.recipe.repositories.find(row => row.repository.toLowerCase() === repository.toLowerCase())?.branch;

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await work(); refresh(); } catch (cause) { setError(message(cause)); refresh(); } finally { setBusy(false); }
  };
  const build = () => run(async () => {
    await draft.settle();
    const revision = draft.revision();
    if (draft.legacy || revision === undefined) await buildCloudV2Computer(organizationId, configured);
    else await buildConfiguredCloudV2Computer(organizationId, revision);
    draft.reset();
  });
  const discard = () => run(async () => {
    // Unsent edits are dropped; a save already sent finishes first, so the
    // discard names the revision it produced.
    draft.reset();
    await draft.settle();
    const current = draft.latest.current, revision = draft.revision();
    if (draft.legacy || revision === undefined || !current.data) return;
    publishRecipe(key, draft.latest, await discardCloudV2ComputerRecipe(organizationId, revision));
  });
  const activate = (buildId: string) => run(() => activateCloudV2Build(organizationId, buildId));

  const update = (repository: string, patch: { ref?: string; setup?: string }) =>
    draft.edit(configured.map(row => {
      if (row.repository !== repository) return row;
      const next = { ...row, ...patch };
      return { repository: next.repository, ...(next.ref?.trim() ? { ref: next.ref.trim() } : {}), ...(next.setup?.trim() ? { setup: next.setup } : {}) };
    }), TYPING_SAVE_MS);
  const remove = (repository: string) => draft.edit(configured.filter(row => row.repository !== repository), 0);
  const same = (row: CloudV2RepositoryDraft, repository: { owner: string; name: string }) =>
    row.repository.toLowerCase() === `${repository.owner}/${repository.name}`.toLowerCase();
  const toggle = (repository: CloudRepositorySelection) => {
    const existing = configured.find(row => same(row, repository));
    if (existing) { remove(existing.repository); return; }
    if (configured.length >= MAX_REPOSITORIES) { setError(`A Cloud Computer holds up to ${MAX_REPOSITORIES} repositories.`); return; }
    setError(null);
    draft.edit([...configured, { repository: `${repository.owner}/${repository.name}` }], 0);
  };

  if (!canManage)
    return <SettingsSection title="Cloud Computer" description="Only organization owners and admins manage the Cloud Computer." />;
  const locked = busy || running;
  return (
    <div className="flex flex-col gap-6" {...(!active ? { inert: "" } : {})} aria-hidden={!active || undefined}>
      {error && <p className="text-red-primary text-xs" role="alert">{error}</p>}
      {computer.error && <p className="text-red-primary text-xs" role="alert">Cloud Computer could not be refreshed.</p>}
      <SettingsGroup>
        <div className="flex items-center justify-between gap-4">
          <StatusSummary status={status} />
          <div className="flex shrink-0 items-center gap-2">
            {status.kind === "unbuilt" && (
              <Button variant="ghost" onClick={() => void discard()} disabled={locked}>Discard</Button>
            )}
            <Button variant={status.kind === "unbuilt" ? "default" : "secondary"} onClick={() => void build()}
              disabled={locked || configured.length === 0 || data === undefined}>
              {running ? "Building…" : "Build computer"}
            </Button>
          </div>
        </div>
        {builds.length > 0 && (
          <div className="flex flex-col gap-1">
            <Button variant="ghost" className="text-fg2 w-full justify-between" aria-expanded={historyOpen}
              onClick={() => setHistoryOpen(open => !open)}>
              <span>History ({builds.length})</span>
              {historyOpen ? <ChevronUp aria-hidden /> : <ChevronDown aria-hidden />}
            </Button>
            {historyOpen && (
              <ul className="divide-border1 flex flex-col divide-y" aria-label="Cloud Computer builds">
                {builds.map(row => (
                  <HistoryRow key={row.id} build={row} active={row.id === data?.activeBuildId}
                    disabled={locked} onActivate={() => void activate(row.id)} />
                ))}
              </ul>
            )}
          </div>
        )}
      </SettingsGroup>

      <SettingsGroup title="Repositories" description="Available to members who have repository access. Changes take effect after you build the computer.">
        {configured.map(row => (
          <div key={row.repository} className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3">
              <span className="text-fg1 inline-flex min-w-0 items-center gap-2 text-xs font-medium">
                <GithubIcon className="size-3.5 shrink-0" aria-hidden />
                <span className="truncate">{row.repository}</span>
              </span>
              <Button variant="ghost" size="icon-sm" aria-label={`Remove ${row.repository}`}
                onClick={() => remove(row.repository)} disabled={locked}>
                <X aria-hidden />
              </Button>
            </div>
            <Input aria-label={`${row.repository} branch`} placeholder={`Branch or tag (default: ${liveBranch(row.repository) ?? "the repository's default"})`}
              value={row.ref ?? ""} onChange={event => update(row.repository, { ref: event.target.value })} disabled={locked} />
            <CodeTextarea aria-label={`${row.repository} setup command`} value={row.setup ?? ""}
              readOnly={locked} offscreen={!active} onChange={value => update(row.repository, { setup: value })}
              description="Setup script, run in the checkout during each build and once in each new workspace (e.g. pnpm install)" />
          </div>
        ))}
        <div className="flex flex-col gap-1">
          <CloudRepositoryPicker userId={userId} organizationId={organizationId} multiple active={active}
            disabled={locked || data === undefined} label={configured.length ? "Add or remove repositories" : "Add repositories"}
            isSelected={repository => configured.some(row => same(row, repository))} onToggle={toggle} />
        </div>
      </SettingsGroup>
    </div>
  );
}

const STATUS_ICON: Record<ComputerStatus["kind"], React.ReactNode> = {
  loading: null,
  building: <LoaderCircle className="text-fg2 size-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />,
  unbuilt: <TriangleAlert className="text-fg1 size-4 shrink-0" aria-hidden />,
  failed: <CircleX className="text-red-primary size-4 shrink-0" aria-hidden />,
  built: null,
  empty: null,
};

function StatusSummary({ status }: { status: ComputerStatus }) {
  const icon = STATUS_ICON[status.kind];
  return (
    <div className="flex min-w-0 items-center gap-3" role="status">
      {icon}
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className={status.kind === "built" || status.kind === "loading" ? "text-fg2 text-xs" : "text-fg1 text-xs font-medium"}>{status.title}</span>
        {status.detail && <span className="text-fg2 text-xs">{status.detail}</span>}
      </div>
    </div>
  );
}

const BUILD_ICON: Record<CloudV2Build["state"], { icon: React.ReactNode; label: string }> = {
  succeeded: { icon: <CircleCheck className="text-fg2 size-4 shrink-0" aria-hidden />, label: "Built" },
  failed: { icon: <CircleX className="text-red-primary size-4 shrink-0" aria-hidden />, label: "Failed" },
  cancelled: { icon: <CircleMinus className="text-fg3 size-4 shrink-0" aria-hidden />, label: "Cancelled" },
  queued: { icon: <LoaderCircle className="text-fg2 size-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />, label: "Queued" },
  building: { icon: <LoaderCircle className="text-fg2 size-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />, label: "Building" },
};

function HistoryRow({ build, active, disabled, onActivate }: {
  build: CloudV2Build; active: boolean; disabled: boolean; onActivate(): void;
}) {
  const state = BUILD_ICON[build.state], note = historyNote(build);
  return (
    <li className="flex items-center justify-between gap-3 py-2">
      <span className="flex min-w-0 items-center gap-3">
        <span title={state.label} className="inline-flex">{state.icon}<span className="sr-only">{state.label}</span></span>
        <span className="text-fg1 text-xs font-medium">Build #{build.version}</span>
        <span className="text-muted-fg truncate text-xs">
          {[relativeAge(build.finishedAt ?? build.createdAt, Date.now()), note].filter(Boolean).join(" · ")}
        </span>
      </span>
      {active
        ? <Badge variant="outline" className="font-mono uppercase">Active</Badge>
        : build.state === "succeeded" && (
          <Button variant="ghost" onClick={onActivate} disabled={disabled}
            title="Builds this version again at the same commits and makes it live">Activate</Button>
        )}
    </li>
  );
}
