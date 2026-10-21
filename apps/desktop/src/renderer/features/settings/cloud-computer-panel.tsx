// Cloud Computer for cloud workspace v2. An organization owner or admin picks
// the repositories to install and their setup commands; a build installs them
// and becomes the organization's one live snapshot. New cloud workspaces fork
// it with the repositories already installed. Older builds stay listed and can
// be made active again, which rebuilds them at the same commits.
import { useEffect, useState } from "react";
import { Button, Input } from "../../shared/ui";
import { CodeTextarea } from "../../shared/ui/primitives";
import { KeyedAsyncCache } from "../../shared/lib/keyed-async-cache";
import { useCachedRead } from "../../state/use-cached-read";
import { useActiveOrganization, useTeams } from "../team/team-store";
import { ControlPlaneError } from "../team/control-plane";
import { SettingsSection, SettingsList, SettingsRow } from "./settings-ui";
import { CloudRepositoryPicker, type CloudRepositorySelection } from "./cloud-repository-picker";
import { activateCloudV2Build, buildCloudV2Computer, getCloudV2Computer, type CloudV2Build } from "../../platform/cloud-v2";

type Computer = Awaited<ReturnType<typeof getCloudV2Computer>>;
const computers = new KeyedAsyncCache<Computer>({ maxEntries: 16 });
const STATE_LABEL: Record<CloudV2Build["state"], string> = {
  queued: "Queued", building: "Building", succeeded: "Built", failed: "Failed", cancelled: "Cancelled",
};
type Draft = { repository: string; ref: string; setup: string };

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

function CloudComputerScope({ userId, organizationId, canManage, active }: {
  userId: string; organizationId: string; canManage: boolean; active: boolean;
}) {
  const key = computerKey(userId, organizationId);
  const computer = useCachedRead(computers, canManage ? key : null, () => getCloudV2Computer(organizationId),
    { enabled: active, maxAgeMs: 30_000 });
  const latest = computer.data?.builds[0];
  const running = latest?.state === "queued" || latest?.state === "building";
  const refresh = computer.refresh;
  useEffect(() => {
    if (!active || !running) return;
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [active, running, refresh]);

  const [selected, setSelected] = useState<CloudRepositorySelection[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draft = (repository: string): Draft => drafts[repository] ?? { repository, ref: "", setup: "" };
  const update = (repository: string, patch: Partial<Draft>) =>
    setDrafts(current => ({ ...current, [repository]: { ...draft(repository), ...patch } }));
  const slug = (repo: CloudRepositorySelection) => `${repo.owner}/${repo.name}`;

  const build = async () => {
    setBusy(true); setError(null);
    try {
      await buildCloudV2Computer(organizationId, selected.map(repo => {
        const entry = draft(slug(repo));
        return { repository: slug(repo), ...(entry.ref.trim() ? { ref: entry.ref.trim() } : {}),
          ...(entry.setup.trim() ? { setup: entry.setup } : {}) };
      }));
      refresh();
    } catch (cause) { setError(message(cause)); } finally { setBusy(false); }
  };
  const activate = async (buildId: string) => {
    setBusy(true); setError(null);
    try { await activateCloudV2Build(organizationId, buildId); refresh(); }
    catch (cause) { setError(message(cause)); } finally { setBusy(false); }
  };

  if (!canManage)
    return <SettingsSection title="Cloud Computer" description="Only organization owners and admins manage the Cloud Computer." />;
  const active_ = computer.data?.builds.find(row => row.id === computer.data?.activeBuildId);
  return (
    <div className="flex flex-col gap-6" {...(!active ? { inert: "" } : {})} aria-hidden={!active || undefined}>
      {error && <p className="text-red-primary text-xs" role="alert">{error}</p>}
      {computer.error && <p className="text-red-primary text-xs" role="alert">Cloud Computer could not be refreshed.</p>}
      <SettingsSection title="Cloud Computer"
        description="New cloud workspaces start from this computer, with these repositories already installed.">
        <SettingsList>
          <SettingsRow label="Live build" hint={active_ ? `Version ${active_.version}` : "No build yet"}>
            <span className="text-fg2 text-xs">
              {active_ ? active_.recipe.repositories.map(row => row.repository).join(", ") : "Build one below to enable cloud workspaces."}
            </span>
          </SettingsRow>
        </SettingsList>
      </SettingsSection>

      <SettingsSection title="Repositories" description="Choose the repositories to install and how to set each one up.">
        <CloudRepositoryPicker userId={userId} organizationId={organizationId} value={selected} onChange={setSelected}
          multiple disabled={busy || running} active={active} />
        {selected.length > 0 && (
          <SettingsList>
            {selected.map(repo => (
              <SettingsRow key={repo.id} label={slug(repo)} hint="Branch to install (default branch if empty) and a setup command."
                align="start">
                <div className="flex w-full flex-col gap-2">
                  <Input aria-label={`${slug(repo)} branch`} placeholder={repo.defaultBranch} value={draft(slug(repo)).ref}
                    onChange={event => update(slug(repo), { ref: event.target.value })} disabled={busy || running} />
                  <CodeTextarea aria-label={`${slug(repo)} setup command`} value={draft(slug(repo)).setup}
                    readOnly={busy || running} offscreen={!active} onChange={value => update(slug(repo), { setup: value })}
                    description="Runs in the checkout as a non-interactive bash script, for example pnpm install." />
                </div>
              </SettingsRow>
            ))}
          </SettingsList>
        )}
        <div className="flex justify-end">
          <Button onClick={() => void build()} disabled={busy || running || selected.length === 0}>
            {running ? "Building…" : "Build Cloud Computer"}
          </Button>
        </div>
      </SettingsSection>

      <SettingsSection title="Builds" description="Every build is kept. Making an older build active rebuilds it at the same commits.">
        <SettingsList>
          {(computer.data?.builds ?? []).map(row => (
            <SettingsRow key={row.id} label={`Version ${row.version}${row.recipe.rebuiltFrom ? ` (rebuilt from ${row.recipe.rebuiltFrom})` : ""}`}
              hint={`${STATE_LABEL[row.state]} · ${row.recipe.repositories.map(repo => repo.repository).join(", ")}`}>
              {row.id === computer.data?.activeBuildId
                ? <span className="text-green-primary text-xs">Live</span>
                : row.state === "succeeded" && (
                  <Button variant="ghost" onClick={() => void activate(row.id)} disabled={busy || running}>Make active</Button>
                )}
            </SettingsRow>
          ))}
        </SettingsList>
      </SettingsSection>
    </div>
  );
}
