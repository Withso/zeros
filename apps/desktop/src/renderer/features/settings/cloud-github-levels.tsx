import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { GithubConnectionDrawer } from "./github-connection-drawer";
import { useSharedGithub } from "./use-shared-github";
import { Button, GithubIcon } from "../../shared/ui";
import { Switch } from "../../shared/ui/primitives/switch";
import { MessageRow } from "../../shared/ui/primitives/message-row";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../../shared/ui/primitives/sheet";
import { KeyedAsyncCache } from "../../shared/lib/keyed-async-cache";
import { useRecoveringRead } from "../../state/use-recovering-read";
import { changeCloudGithubConnection } from "../../platform/cloud-github-connection";
import { shellOpenUrl } from "../../platform/app";
import { ControlPlaneError } from "../team/control-plane";
import {
  connectCloudGithubInstallation,
  getCloudGithubLevelConnections, getCloudGithubVisibleInstallations, getCloudProjects, projectForRepository, setCloudPersonalProjectsAllowed,
  type CloudGithubLevelConnection, type CloudGithubLevelConnections, type CloudGithubVisibleInstallation, type CloudProject, type CloudProjects,
} from "../../platform/cloud-github-levels";
import { message } from "./cloud-computer-store";
import { SettingsAddRow, SettingsGroup, SettingsLinkRow, SettingsRow } from "./settings-ui";

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
type ConnectionSheet = { kind: "add"; level: CloudGithubLevelConnection["level"] } | { kind: "link" | "reinstall" | "view"; id: string };
type Level = CloudGithubLevelConnection["level"];

function useVisibleInstallations(userId: string, organizationId: string, generation: string | undefined, active: boolean) {
  return useRecoveringRead(installations, generation ? JSON.stringify([userId, organizationId, generation]) : null,
    () => getCloudGithubVisibleInstallations(organizationId), { enabled: active && !!generation, maxAgeMs: 15_000 });
}

export function GithubConnectionGroups({ userId, organizationId, organizationName, canManage, active, personal = false, onConfigureIdentity }: {
  userId: string; organizationId: string; organizationName: string; canManage: boolean; active: boolean;
  personal?: boolean; onConfigureIdentity?: (() => void) | undefined;
}) {
  const levels = useGithubLevels(userId, organizationId, active);
  const identity = useSharedGithub({ userId, organizationId, name: organizationName }, active);
  const [sheet, setSheet] = useState<ConnectionSheet | null>(null);
  const [handoffError, setHandoffError] = useState<string | null>(null);
  const status = identity.read.data;
  const app = status?.selectedMethod === "github-app" && status.methods["github-app"].configured && !identity.read.readError;
  const visible = useVisibleInstallations(userId, organizationId, app ? status.generation : undefined, active);
  const connections = levels.connections;
  if (!connections) return null;
  const own = connections.personal.filter(row => row.mine);
  // Personal's own cloud has one person: one list, and "Only you" only if it already holds rows.
  const groups = [
    { level: "organization" as const, name: personal ? "Connections" : `Shared with ${organizationName}`, rows: connections.organization, editable: canManage },
    ...(personal && !own.length ? [] : [{ level: "personal" as const, name: "Only you", rows: own, editable: true }]),
  ];
  const selected = sheet && sheet.kind !== "add"
    ? [...connections.organization, ...own].find(row => row.id === sheet.id) : undefined;
  const installUrl = status?.installUrl;
  const appLogin = status?.methods["github-app"].login;
  const visibleIds = visible.data && new Set(visible.data.map(item => item.installationId));
  function accessHint(row: CloudGithubLevelConnection) {
    if (row.state !== "active" || row.installationId === null || !app) return null;
    if (visible.readError) return "Couldn’t verify GitHub access";
    if (!visibleIds) return "Checking GitHub access…";
    if (visibleIds.has(row.installationId)) return null;
    return appLogin ? `No access as @${appLogin}` : "No access with this GitHub account";
  }
  function needsLink(row: CloudGithubLevelConnection) {
    if (row.state !== "active") return false;
    if (row.installationId === null) return canManage && row.level === "organization";
    return !!status && !identity.read.readError && !app;
  }
  const close = () => { setSheet(null); setHandoffError(null); };
  // After the sheet has unmounted, so its focus trap doesn't take focus back.
  const configureIdentity = () => { close(); requestAnimationFrame(() => onConfigureIdentity?.()); };
  // Selecting a saved App completes sign-in. A bound connection then opens its ordinary details.
  const showDetails = sheet?.kind === "view" || (sheet?.kind === "link" && selected?.installationId != null && app);
  const selectedHint = selected && accessHint(selected);
  const accessNotice = selectedHint && selected && <SettingsGroup title={selectedHint}>
    {visible.readError ? <MessageRow tone="error" role="alert" flush>{message(visible.readError)}</MessageRow>
      : visibleIds && <>
        <SettingsRow label={`Get access to a repository owned by @${selected.accountLogin} on GitHub.`} />
        <SettingsRow label="Switch to a GitHub account with access under Configure account identity.">
          <Button variant="secondary" onClick={configureIdentity}>Configure account identity</Button>
        </SettingsRow>
      </>}
    <Button variant="ghost" disabled={visible.refreshing || visible.loading} onClick={visible.refresh}>Refresh installations</Button>
  </SettingsGroup>;
  const reinstall = async (row: CloudGithubLevelConnection) => {
    if (!installUrl) return;
    setHandoffError(null);
    setSheet({ kind: "reinstall", id: row.id });
    try { await shellOpenUrl(installUrl); } catch (cause) { setHandoffError(message(cause)); }
  };
  return <>
    <div className="flex flex-col gap-6">
        {groups.map(group => <SettingsGroup key={group.level} title={group.name} aria-label={group.name}>
          {group.rows.length === 0 && !group.editable && <SettingsRow label="No connections yet" />}
          {group.rows.map(row => {
            const reinstallable = group.editable && row.state === "uninstalled";
            const linkable = needsLink(row);
            return <SettingsLinkRow key={row.id} label={`@${row.accountLogin}`} leading={<GithubIcon className="text-fg3 size-4" aria-hidden />}
              hint={connectionStateHint(row) ?? accessHint(row) ?? (group.editable ? "Connected" : "Managed by admins")}
              aria-label={`View @${row.accountLogin}`} onClick={() => setSheet({ kind: "view", id: row.id })}
              action={reinstallable || linkable ? <>
                {reinstallable && <Button variant="secondary" disabled={!installUrl}
                  aria-label={`Reinstall @${row.accountLogin}`} onClick={() => void reinstall(row)}>Reinstall</Button>}
                {linkable && <Button variant="secondary"
                  aria-label={`Link @${row.accountLogin}`} onClick={() => setSheet({ kind: "link", id: row.id })}>Link</Button>}
              </> : undefined} />;
          })}
          {group.editable && <SettingsAddRow label="Add connection" onClick={() => setSheet({ kind: "add", level: group.level })} />}
        </SettingsGroup>)}
    </div>
    {active && showDetails && selected && <GithubConnectionDrawer key={selected.id} userId={userId} organizationId={organizationId}
      connection={selected} canManage={selected.level === "personal" || canManage} personal={personal} accountLogin={appLogin} accountType={visible.data?.find(item => item.installationId === selected.installationId)?.accountType} accessNotice={accessNotice} credentialGeneration={status?.generation} installUrl={installUrl}
      onChanged={levels.refresh} onClose={close} />}
    {active && !showDetails && (sheet?.kind === "add" || ((sheet?.kind === "link" || sheet?.kind === "reinstall") && selected)) &&
      <AddConnection key={selected?.id ?? "add"} userId={userId} organizationId={organizationId} organizationName={organizationName}
        canManage={canManage} connections={connections} target={selected} initialLevel={sheet.kind === "add" ? sheet.level : undefined} reinstalling={sheet.kind === "reinstall"} handoffError={handoffError} visible={visible} status={status} app={app} readError={identity.read.readError}
        onRefreshConnections={levels.refresh} onRefreshIdentity={identity.read.refresh} onConfigureIdentity={configureIdentity}
        onClose={close} onConnected={() => { levels.refresh(); close(); }} />}
  </>;
}

function AddConnection({ userId, organizationId, organizationName, canManage, connections, target, initialLevel, status, app, visible, readError, reinstalling, handoffError, onRefreshConnections, onRefreshIdentity,
  onConfigureIdentity, onClose, onConnected }: {
  userId: string; organizationId: string; organizationName: string; canManage: boolean; connections: CloudGithubLevelConnections;
  target?: CloudGithubLevelConnection | undefined; initialLevel?: Level | undefined; status: ReturnType<typeof useSharedGithub>["read"]["data"]; readError: unknown;
  app: boolean; visible: ReturnType<typeof useVisibleInstallations>; reinstalling: boolean; handoffError: string | null; onRefreshConnections(): void; onRefreshIdentity(): void; onConfigureIdentity(): void; onClose(): void; onConnected(): void;
}) {
  const [level, setLevel] = useState<Level>(target?.level ?? initialLevel ?? "personal");
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const connected = new Set([...connections.organization, ...connections.personal].map(row => row.installationId));
  const choices = (visible.data ?? []).filter(row => !row.suspended && !connected.has(row.installationId) &&
    (!target || target.accountLogin.toLowerCase() === row.accountLogin.toLowerCase()));
  const existing = target?.installationId != null && !reinstalling;
  const replacement = reinstalling && target && visible.data?.some(row => row.installationId !== target.installationId &&
    row.accountLogin.toLowerCase() === target.accountLogin.toLowerCase());
  async function save(action: () => Promise<unknown>, complete: () => void) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      complete();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }
  function connect(id: number) {
    if (existing || reinstalling || !app || visible.readError || (level === "organization" && !canManage)) return;
    void save(() => connectCloudGithubInstallation(organizationId, id, level), onConnected);
  }
  const installUrl = status?.installUrl;
  return <Sheet open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <SheetContent className="overflow-y-auto p-6">
      <SheetHeader><SheetTitle>{reinstalling && target ? `Reinstall @${target.accountLogin}` : target ? `Link @${target.accountLogin}` : "Add connection"}</SheetTitle>
        <SheetDescription>{existing ? "Sign in with GitHub App for Cloud to use this installation." : target ? "Link the matching GitHub installation." : "Choose where this GitHub installation will be available."}</SheetDescription>
      </SheetHeader>
      {canManage && !target ? <SettingsRow label="Connection for">
        <Button variant={level === "personal" ? "secondary" : "ghost"} aria-pressed={level === "personal"} disabled={busy} onClick={() => setLevel("personal")}>Only you</Button>
        <Button variant={level === "organization" ? "secondary" : "ghost"} aria-pressed={level === "organization"} disabled={busy} onClick={() => setLevel("organization")}>{organizationName}</Button>
      </SettingsRow> : <SettingsRow label="Connection for" hint={level === "personal" ? "Only you" : organizationName} />}
      {(error || handoffError) && <MessageRow tone="error" role="alert" flush>{error || handoffError}</MessageRow>}
      {readError ? <SettingsRow label="Couldn’t read the Cloud identity"><Button onClick={onRefreshIdentity}>Retry</Button></SettingsRow>
        : !status ? <MessageRow flush>Loading Cloud identity…</MessageRow>
        : !app ? <SettingsRow label="Finding installations needs GitHub App sign-in." hint="Choose GitHub App for Cloud in your account settings.">
          {status.methods["github-app"].configured
            ? <Button disabled={busy} onClick={() => void save(() => changeCloudGithubConnection(userId, organizationId, status.generation,
              { action: "select", method: "github-app" }), onRefreshIdentity)}>Use GitHub App for Cloud</Button>
            : <Button onClick={onConfigureIdentity}>Configure account identity</Button>}</SettingsRow>
        : <SettingsGroup title={reinstalling ? "Installation status" : "Installed accounts"}>
          {reinstalling && <SettingsRow label={target?.state === "active" ? "Connected" : replacement
            ? "GitHub returned a different installation" : "Waiting for the installation"}
            hint={replacement ? "The existing connection still points to the old installation. Adding the new one creates a separate connection." : "Refresh after returning from GitHub."} />}
          {visible.error && <MessageRow tone="error" role="alert" flush>{message(visible.error)}</MessageRow>}
          {visible.loading && <MessageRow flush>Loading installations…</MessageRow>}
          {!reinstalling && visible.data && !visible.readError && !choices.length && <SettingsRow label="No available installations" />}
          {!reinstalling && choices.map(row => <SettingsRow key={row.installationId} label={`@${row.accountLogin}`}>
            <Button aria-label={`Link @${row.accountLogin}`} disabled={busy || !!visible.readError} onClick={() => void connect(row.installationId)}>Link</Button>
          </SettingsRow>)}
          <div className="flex items-center gap-2">
            {installUrl && <Button variant="secondary" onClick={() => void shellOpenUrl(installUrl).catch(cause => setError(message(cause)))}>Install on another account<ExternalLink aria-hidden /></Button>}
            <Button variant="ghost" disabled={busy || visible.refreshing} onClick={() => { visible.refresh(); onRefreshConnections(); }}>Refresh installations</Button>
          </div>
        </SettingsGroup>}
    </SheetContent>
  </Sheet>;
}

export const PERSONAL_PROJECTS_HINT = "Members can create projects only they can use. Turning this off stops new ones; existing workspaces keep working.";

/** Owners and admins allow or forbid projects for one member. */
export function PersonalProjectsSetting({ userId, organizationId, canManage, active }: { userId: string; organizationId: string; canManage: boolean; active: boolean }) {
  const levels = useGithubLevels(userId, organizationId, active);
  const [error, setError] = useState<string | null>(null);
  if (!levels.projects) return null;
  const allowed = levels.projects.personalAllowed;
  return (
    <SettingsGroup>
      {error && <MessageRow tone="error" role="alert" flush>{error}</MessageRow>}
      <SettingsRow label="Personal projects" hint={canManage ? PERSONAL_PROJECTS_HINT : "Managed by admins"}>
        <Switch checked={allowed} disabled={!canManage} aria-label="Projects for one member"
          onCheckedChange={value => void setCloudPersonalProjectsAllowed(organizationId, value).then(levels.refresh, cause => setError(message(cause)))} />
      </SettingsRow>
    </SettingsGroup>
  );
}
