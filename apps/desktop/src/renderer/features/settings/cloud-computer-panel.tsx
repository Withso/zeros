// Cloud Computer for cloud workspace v2. An organization owner or admin keeps
// the repositories to install and their setup as an organization setting; a
// build makes them the organization's one live snapshot. New cloud
// workspaces fork it with the repositories already installed. Repositories
// stay until an admin removes them, and every edit waits for the next build.
// Older builds stay in the history and can be made active again, which
// rebuilds them at the same commits.
import { useCallback, useEffect, useState } from "react";
import { IconButton } from "@/renderer/shared/ui/primitives/icon-button";
import { ChevronDown, ChevronUp, CircleCheck, CircleMinus, CircleX, LoaderCircle, TriangleAlert, X } from "lucide-react";
import { Button } from "../../shared/ui";
import { Badge, Pill } from "../../shared/ui/primitives";
import { MessageRow } from "../../shared/ui/primitives/message-row";
import { useRecoveringRead } from "../../state/use-recovering-read";
import { useActiveOrganization, useTeams } from "../team/team-store";
import { assertComputerOwner, computerKey, computers, MAX_REPOSITORIES, message, publishRecipe, useRecipeDraft } from "./cloud-computer-store";
import { SettingsGroup, SettingsSection } from "./settings-ui";
import { CloudRepositoryChooser } from "./cloud-repository-chooser";
import type { ChooserRepository } from "./cloud-repository-chooser-model";
import {
  activateCloudV2Build, buildCloudV2Computer, buildConfiguredCloudV2Computer, discardCloudV2ComputerRecipe,
  getCloudV2Computer, type CloudV2Build, type CloudV2RepositoryDraft,
} from "../../platform/cloud-v2";
import { computerChanges, computerStatus, editableRepositories, historyNote, relativeAge, type ComputerStatus } from "./cloud-computer-model";
export { prefetchCloudComputer } from "./cloud-computer-store";

export function CloudComputerPanel({ surfaceActive = true, openCloudRepository }: {
  surfaceActive?: boolean; openCloudRepository?(repository: string): void;
}) {
  const organization = useActiveOrganization();
  const { me } = useTeams();
  if (!organization || organization.isPersonal || !me) return null;
  const canManage = organization.role === "owner" || organization.role === "admin";
  return <CloudComputerScope key={computerKey(me.user.id, organization.id)} userId={me.user.id}
    organizationId={organization.id} canManage={canManage} active={surfaceActive} openRepository={openCloudRepository} />;
}

function CloudComputerScope({ userId, organizationId, canManage, active, openRepository }: {
  userId: string; organizationId: string; canManage: boolean; active: boolean; openRepository?(repository: string): void;
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

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await work(); refresh(); } catch (cause) { setError(message(cause)); refresh(); } finally { setBusy(false); }
  };
  const build = () => run(async () => {
    await draft.settle();
    assertComputerOwner(key, organizationId);
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
    assertComputerOwner(key, organizationId);
    const current = draft.latest.current, revision = draft.revision();
    if (draft.legacy || revision === undefined || !current.data) return;
    const saved = await discardCloudV2ComputerRecipe(organizationId, revision);
    assertComputerOwner(key, organizationId);
    publishRecipe(key, draft.latest, saved);
  });
  const activate = (buildId: string) => run(() => { assertComputerOwner(key, organizationId); return activateCloudV2Build(organizationId, buildId); });

  const remove = (repository: string) => draft.edit(configured.filter(row => row.repository !== repository), 0);
  const same = (row: CloudV2RepositoryDraft, repository: { owner: string; name: string }) =>
    row.repository.toLowerCase() === `${repository.owner}/${repository.name}`.toLowerCase();
  const isChosen = useCallback((repository: { owner: string; name: string }) => configured.some(row => same(row, repository)), [configured]);
  const limit = () => setError(`A Cloud Computer holds up to ${MAX_REPOSITORIES} repositories.`);
  const toggle = (repository: ChooserRepository) => {
    const existing = configured.find(row => same(row, repository));
    if (existing) { remove(existing.repository); return; }
    if (configured.length >= MAX_REPOSITORIES) { limit(); return; }
    setError(null);
    draft.edit([...configured, { repository: `${repository.owner}/${repository.name}` }], 0);
  };
  const chooseAll = (repositories: ChooserRepository[], choose: boolean) => {
    if (!choose) { draft.edit(configured.filter(row => !repositories.some(repository => same(row, repository))), 0); return; }
    const added = repositories.filter(repository => !configured.some(row => same(row, repository)))
      .map(repository => ({ repository: `${repository.owner}/${repository.name}` }));
    const room = MAX_REPOSITORIES - configured.length;
    if (added.length > room) limit(); else setError(null);
    if (room > 0) draft.edit([...configured, ...added.slice(0, room)], 0);
  };

  if (!canManage)
    return <SettingsSection title="Cloud Computer" description="Only owners and admins manage it." />;
  const locked = busy || running;
  return (
    <div className="flex flex-col gap-8" {...(!active ? { inert: "" } : {})} aria-hidden={!active || undefined}>
      {error && <MessageRow tone="error" role="alert" flush>{error}</MessageRow>}
      {computer.error && <MessageRow tone="error" role="alert" flush>Cloud Computer could not be refreshed.</MessageRow>}
      <SettingsGroup>
        <div className="flex items-center justify-between gap-4">
          <StatusSummary status={status} />
          <div className="flex shrink-0 items-center gap-2">
            {status.kind === "unbuilt" && (
              <Button variant="ghost" onClick={() => void discard()} disabled={locked}>Discard</Button>
            )}
            <Button variant={status.kind === "unbuilt" ? "primary" : "secondary"} onClick={() => void build()}
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

      <SettingsGroup title="Repositories" description="Changes apply after the next build.">
        <CloudRepositoryChooser userId={userId} organizationId={organizationId} active={active}
          disabled={locked || data === undefined} chosenCount={configured.length} isChosen={isChosen}
          onToggle={toggle} onChooseAll={chooseAll} />
        {configured.length > 0 && (
          <ul className="m-0 flex list-none flex-wrap gap-2 p-0" aria-label="Chosen repositories">
            {configured.map(row => (
              <li key={row.repository} className="inline-flex items-center gap-0.5">
                <Pill size="control" onClick={() => openRepository?.(row.repository)} title={`Open ${row.repository} settings`}>
                  {row.repository}
                </Pill>
                <IconButton size="compact" label={`Remove ${row.repository}`} onClick={() => remove(row.repository)} disabled={locked}>
                  <X aria-hidden />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
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
    <li className="flex min-h-10 items-center justify-between gap-3 py-2">
      <span className="flex min-w-0 items-center gap-3">
        <span title={state.label} className="inline-flex">{state.icon}<span className="sr-only">{state.label}</span></span>
        <span className="text-fg1 text-xs font-medium">Build #{build.version}</span>
        <span className="text-muted-fg truncate text-xs">
          {[relativeAge(build.finishedAt ?? build.createdAt, Date.now()), note].filter(Boolean).join(" · ")}
        </span>
      </span>
      {active
        ? <Badge variant="success">Active</Badge>
        : build.state === "succeeded" && (
          <Button variant="ghost" size="compact" onClick={onActivate} disabled={disabled}
            title="Builds this version again at the same commits and makes it live">Activate</Button>
        )}
    </li>
  );
}
