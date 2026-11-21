import { useState } from "react";
import { Button } from "../../shared/ui";
import { Badge } from "../../shared/ui/primitives";
import { Switch } from "../../shared/ui/primitives/switch";
import { MessageRow } from "../../shared/ui/primitives/message-row";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../../shared/ui/primitives/sheet";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../shared/ui/primitives/select";
import { KeyedAsyncCache } from "../../shared/lib/keyed-async-cache";
import { useRecoveringRead } from "../../state/use-recovering-read";
import { shellOpenUrl } from "../../platform/app";
import { ControlPlaneError } from "../team/control-plane";
import {
  addCloudRepository, connectCloudGithubInstallation, disconnectCloudGithubConnection, getCloudGithubConnectionRepositories,
  getCloudGithubLevelConnections, getCloudGithubVisibleInstallations, getCloudRepositoryLevels, setCloudPersonalRepositoriesAllowed,
  type CloudGithubLevelConnection, type CloudGithubLevelConnections, type CloudGithubVisibleInstallation, type CloudRepositoryLevels,
} from "../../platform/cloud-github-levels";
import { message } from "./cloud-computer-store";
import { SettingsGroup, SettingsRow } from "./settings-ui";

/** Null: this control plane has no GitHub levels (ready copies off or older). */
export const githubLevelConnections = new KeyedAsyncCache<CloudGithubLevelConnections | null>({ maxEntries: 16 });
export const cloudRepositoryLevels = new KeyedAsyncCache<CloudRepositoryLevels | null>({ maxEntries: 16 });
const installations = new KeyedAsyncCache<CloudGithubVisibleInstallation[]>({ maxEntries: 16 });
const absent = (error: unknown) => { if (error instanceof ControlPlaneError && error.status === 404) return null; throw error; };
export const githubLevelsKey = (userId: string, organizationId: string) => JSON.stringify([userId, organizationId]);

export function useGithubLevels(userId: string, organizationId: string, active: boolean) {
  const key = githubLevelsKey(userId, organizationId);
  const connections = useRecoveringRead(githubLevelConnections, key, () => getCloudGithubLevelConnections(organizationId).catch(absent),
    { enabled: active, maxAgeMs: 30_000 });
  const repositories = useRecoveringRead(cloudRepositoryLevels, key, () => getCloudRepositoryLevels(organizationId).catch(absent),
    { enabled: active && connections.data !== null, maxAgeMs: 30_000 });
  return { key, connections: connections.data, repositories: repositories.data,
    refresh: () => { connections.refresh(); repositories.refresh(); } };
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
      <ConnectionRepositories organizationId={organizationId} connection={open} onClose={() => { setOpen(null); levels.refresh(); }}
        addLevel={level === "organization" && canManage ? "shared" : "private"} canAdd={level === "personal" || canManage} />
    </SettingsGroup>
  );
}

/** The drawer: what the caller can read through one connection, what is
 * already added, and Add to cloud at this connection's level. */
export function ConnectionRepositories({ organizationId, connection, onClose, addLevel, canAdd }: {
  organizationId: string; connection: CloudGithubLevelConnection | null; onClose(): void; addLevel: "shared" | "private"; canAdd: boolean;
}) {
  const key = connection ? JSON.stringify([organizationId, connection.id]) : null;
  const read = useRecoveringRead(drawers, key, () => getCloudGithubConnectionRepositories(organizationId, connection!.id), { enabled: !!connection, maxAgeMs: 15_000 });
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState<string | null>(null);
  const add = async (repository: string) => {
    setBusy(repository); setError(null);
    try { await addCloudRepository(organizationId, repository, addLevel, connection?.id); read.refresh(); }
    catch (cause) { setError(message(cause)); } finally { setBusy(null); }
  };
  return (
    <Sheet open={!!connection} onOpenChange={value => { if (!value) onClose(); }}>
      <SheetContent side="right" className="p-6">
        <SheetHeader>
          <SheetTitle>{connection?.accountLogin ?? ""}</SheetTitle>
          <SheetDescription>{addLevel === "shared" ? "Added repositories are available to everyone in the organization." : "Added repositories are only yours."}</SheetDescription>
        </SheetHeader>
        {error && <MessageRow tone="error" role="alert" flush>{error}</MessageRow>}
        <ul className="m-0 flex list-none flex-col gap-2 overflow-y-auto p-0" aria-label="Repositories">
          {(read.data?.repositories ?? []).map(row => (
            <li key={row.id} className="flex items-center justify-between gap-2">
              <span className="text-fg1 truncate text-xs">{row.repository}</span>
              {row.added ? <Badge>{row.added === "shared" ? "Shared" : "Only you"}</Badge>
                : canAdd && <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => void add(row.repository)}>Add to cloud</Button>}
            </li>
          ))}
        </ul>
      </SheetContent>
    </Sheet>
  );
}
const drawers = new KeyedAsyncCache<Awaited<ReturnType<typeof getCloudGithubConnectionRepositories>>>({ maxEntries: 16 });

export const PERSONAL_REPOSITORIES_HINT = "Members may add repositories only they can use. Turning this off stops their copies from refreshing and new workspaces of them; existing workspaces keep working.";

/** Owners and admins allow or forbid repositories for one member. */
export function PersonalRepositoriesSetting({ userId, organizationId, canManage, active }: { userId: string; organizationId: string; canManage: boolean; active: boolean }) {
  const levels = useGithubLevels(userId, organizationId, active);
  const [error, setError] = useState<string | null>(null);
  if (!levels.repositories) return null;
  const allowed = levels.repositories.personalAllowed;
  return (
    <SettingsGroup>
      {error && <MessageRow tone="error" role="alert" flush>{error}</MessageRow>}
      <SettingsRow label="Repositories for one member" hint={canManage ? PERSONAL_REPOSITORIES_HINT : "Managed by admins"}>
        <Switch checked={allowed} disabled={!canManage} aria-label="Repositories for one member"
          onCheckedChange={value => void setCloudPersonalRepositoriesAllowed(organizationId, value).then(levels.refresh, cause => setError(message(cause)))} />
      </SettingsRow>
    </SettingsGroup>
  );
}
