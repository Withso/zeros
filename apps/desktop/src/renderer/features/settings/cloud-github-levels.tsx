import { useState } from "react";
import { Button } from "../../shared/ui";
import { Switch } from "../../shared/ui/primitives/switch";
import { MessageRow } from "../../shared/ui/primitives/message-row";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../../shared/ui/primitives/sheet";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../shared/ui/primitives/select";
import { KeyedAsyncCache } from "../../shared/lib/keyed-async-cache";
import { useRecoveringRead } from "../../state/use-recovering-read";
import { shellOpenUrl } from "../../platform/app";
import { ControlPlaneError } from "../team/control-plane";
import {
  connectCloudGithubInstallation, disconnectCloudGithubConnection, getCloudGithubConnectionRepositories,
  getCloudGithubLevelConnections, getCloudGithubVisibleInstallations, getCloudProjects, projectForRepository, setCloudPersonalProjectsAllowed,
  type CloudGithubLevelConnection, type CloudGithubLevelConnections, type CloudGithubVisibleInstallation, type CloudProject, type CloudProjects,
} from "../../platform/cloud-github-levels";
import { message } from "./cloud-computer-store";
import { SettingsGroup, SettingsRow } from "./settings-ui";

/** Null: this control plane has no GitHub levels (ready copies off or older). */
export const githubLevelConnections = new KeyedAsyncCache<CloudGithubLevelConnections | null>({ maxEntries: 16 });
export const cloudProjects = new KeyedAsyncCache<CloudProjects | null>({ maxEntries: 16 });
const installations = new KeyedAsyncCache<CloudGithubVisibleInstallation[]>({ maxEntries: 16 });
const absent = (error: unknown) => { if (error instanceof ControlPlaneError && error.status === 404) return null; throw error; };
export const githubLevelsKey = (userId: string, organizationId: string) => JSON.stringify([userId, organizationId]);

export function useGithubLevels(userId: string, organizationId: string, active: boolean) {
  const key = githubLevelsKey(userId, organizationId);
  const connections = useRecoveringRead(githubLevelConnections, key, () => getCloudGithubLevelConnections(organizationId).catch(absent),
    { enabled: active, maxAgeMs: 30_000 });
  const projects = useRecoveringRead(cloudProjects, key, () => getCloudProjects(organizationId).catch(absent),
    { enabled: active && connections.data !== null, maxAgeMs: 30_000 });
  return { key, connections: connections.data, projects: projects.data,
    refresh: () => { connections.refresh(); projects.refresh(); } };
}

/** A saved or created project, shown at once while the list is read again. */
export function patchCloudProject(key: string, project: CloudProject): void {
  const current = cloudProjects.peekSnapshot(key).data;
  if (!current) return;
  const known = current.projects.some(row => row.id === project.id);
  cloudProjects.setData(key, { ...current, projects: known ? current.projects.map(row => row.id === project.id ? project : row) : [...current.projects, project] });
}

/** The one-repository project whose cloud settings a repository's page shows; null until known or when none. */
export function useCloudProjectFor(userId: string, organizationId: string, repository: string | null | undefined, active: boolean) {
  const levels = useGithubLevels(userId, organizationId, active && !!organizationId);
  return projectForRepository(levels.projects, repository);
}

/** One fix for each GitHub edge state, reusing the reasons Create shows. */
export function connectionStateHint(connection: Pick<CloudGithubLevelConnection, "state" | "accountLogin" | "installationId">): string | null {
  if (connection.state === "suspended") return "Suspended in GitHub. Unsuspend the Zeros App there.";
  if (connection.state === "uninstalled") return "The Zeros App was uninstalled. Install it again in GitHub.";
  if (connection.installationId === null) return "Connect this account's Zeros App installation to finish moving it here.";
  return null;
}
const installationSettingsUrl = (account: string) => `https://github.com/organizations/${encodeURIComponent(account)}/settings/installations`;

/** Connections at one level: the organization's (owners and admins manage,
 * members read) or the caller's own. Each opens a drawer of its repositories. */
export function GithubConnectionsSection({ userId, organizationId, level, canManage, active, title, description }: {
  userId: string; organizationId: string; level: "organization" | "personal"; canManage: boolean; active: boolean;
  title: string; description: string;
}) {
  const levels = useGithubLevels(userId, organizationId, active);
  const visible = useRecoveringRead(installations, canManage ? levels.key : null, () => getCloudGithubVisibleInstallations(organizationId),
    { enabled: active && !!levels.connections, maxAgeMs: 30_000 });
  const [choice, setChoice] = useState<string>(""), [open, setOpen] = useState<CloudGithubLevelConnection | null>(null);
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  if (!levels.connections) return null;
  const rows = level === "organization" ? levels.connections.organization : levels.connections.personal;
  const connected = new Set([...levels.connections.organization, ...levels.connections.personal].map(row => row.installationId));
  const choices = (visible.data ?? []).filter(row => !connected.has(row.installationId));
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await work(); levels.refresh(); } catch (cause) { setError(message(cause)); } finally { setBusy(false); }
  };
  return (
    <SettingsGroup title={title} description={description}>
      {error && <MessageRow tone="error" role="alert" flush>{error}</MessageRow>}
      {rows.length === 0 && <SettingsRow label="No connections yet" hint={canManage ? "Connect an account where the Zeros App is installed." : "Managed by admins"} />}
      {rows.map(connection => {
        const hint = connectionStateHint(connection);
        return (
          <SettingsRow key={connection.id} label={connection.accountLogin}
            hint={hint ?? (level === "organization" && !canManage ? "Managed by admins" : "Connected")}>
            <div className="flex items-center gap-2">
              {connection.state !== "active" && (
                <Button variant="ghost" size="sm" onClick={() => void shellOpenUrl(installationSettingsUrl(connection.accountLogin))}>Open GitHub</Button>
              )}
              <Button variant="secondary" size="sm" onClick={() => setOpen(connection)} disabled={!connection.installationId}>Repositories</Button>
              {canManage && (
                <Button variant="ghost" size="sm" disabled={busy}
                  onClick={() => void run(() => disconnectCloudGithubConnection(organizationId, connection.id))}>Remove</Button>
              )}
            </div>
          </SettingsRow>
        );
      })}
      {canManage && choices.length > 0 && (
        <div className="flex items-center gap-2">
          <Select value={choice} onValueChange={setChoice}>
            <SelectTrigger width="fixed" aria-label="GitHub account to connect"><SelectValue placeholder="Choose an account" /></SelectTrigger>
            <SelectContent>
              {choices.map(row => <SelectItem key={row.installationId} value={String(row.installationId)}>{row.accountLogin}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button variant="secondary" disabled={!choice || busy}
            onClick={() => void run(() => connectCloudGithubInstallation(organizationId, Number(choice), level))}>Connect</Button>
        </div>
      )}
      <ConnectionRepositories organizationId={organizationId} connection={open} onClose={() => { setOpen(null); levels.refresh(); }} />
    </SettingsGroup>
  );
}

/** The drawer: every repository the caller can read through one connection,
 * and which of their projects use each. Projects pick from these; nothing is added here. */
export function ConnectionRepositories({ organizationId, connection, onClose }: {
  organizationId: string; connection: CloudGithubLevelConnection | null; onClose(): void;
}) {
  const key = connection ? JSON.stringify([organizationId, connection.id]) : null;
  const read = useRecoveringRead(connectionRepositoriesCache, key, () => getCloudGithubConnectionRepositories(organizationId, connection!.id), { enabled: !!connection, maxAgeMs: 15_000 });
  return (
    <Sheet open={!!connection} onOpenChange={value => { if (!value) onClose(); }}>
      <SheetContent side="right" className="flex flex-col gap-6 overflow-y-auto p-6">
        <SheetHeader>
          <SheetTitle>{connection?.accountLogin ?? ""}</SheetTitle>
          <SheetDescription>Repositories this connection can read. Projects pick their repositories from these.</SheetDescription>
        </SheetHeader>
        {read.error && <MessageRow tone="error" role="alert" flush>{message(read.error)}</MessageRow>}
        <SettingsGroup title="Repositories" description="Everything this connection can read. Nothing to add here: pick them when you create a project."
          aria-label="Repositories">
          {(read.data?.repositories ?? []).map(row => (
            <SettingsRow key={row.id} label={row.repository} hint={row.private ? "Private" : "Public"}>
              {row.projects.length > 0 && (
                <span className="text-fg3 text-xs">{row.projects.length === 1 ? `In ${row.projects[0]!.name}` : `In ${row.projects.length} projects`}</span>
              )}
            </SettingsRow>
          ))}
        </SettingsGroup>
        {connection && (
          <SettingsGroup title="On GitHub">
            <SettingsRow label="Add or remove repositories" hint="Choose which repositories Zeros can see.">
              <Button variant="secondary" size="sm" onClick={() => void shellOpenUrl(installationSettingsUrl(connection.accountLogin))}>Manage</Button>
            </SettingsRow>
          </SettingsGroup>
        )}
      </SheetContent>
    </Sheet>
  );
}
/** One connection's drawer, by (organization, connection). */
export const connectionRepositoriesCache = new KeyedAsyncCache<Awaited<ReturnType<typeof getCloudGithubConnectionRepositories>>>({ maxEntries: 16 });

export const PERSONAL_PROJECTS_HINT = "Members may keep projects only they can use. Turning this off stops their copies from refreshing and new workspaces of them; existing workspaces keep working.";

/** Owners and admins allow or forbid projects for one member. */
export function PersonalProjectsSetting({ userId, organizationId, canManage, active }: { userId: string; organizationId: string; canManage: boolean; active: boolean }) {
  const levels = useGithubLevels(userId, organizationId, active);
  const [error, setError] = useState<string | null>(null);
  if (!levels.projects) return null;
  const allowed = levels.projects.personalAllowed;
  return (
    <SettingsGroup>
      {error && <MessageRow tone="error" role="alert" flush>{error}</MessageRow>}
      <SettingsRow label="Projects for one member" hint={canManage ? PERSONAL_PROJECTS_HINT : "Managed by admins"}>
        <Switch checked={allowed} disabled={!canManage} aria-label="Projects for one member"
          onCheckedChange={value => void setCloudPersonalProjectsAllowed(organizationId, value).then(levels.refresh, cause => setError(message(cause)))} />
      </SettingsRow>
    </SettingsGroup>
  );
}
