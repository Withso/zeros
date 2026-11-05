import { useLayoutEffect, useRef, useState } from "react";
import { Button, Input } from "../../shared/ui";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../shared/ui/primitives/tabs";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../shared/ui/primitives/dialog";
import { UserEnvironmentPanel } from "../repositories/repositories-panel";
import { useActiveOrganization, useTeams, getOrganizationStoreGeneration } from "../team/team-store";
import { isFeatureEnabled } from "../../config/release-channel";
import { useRecoveringRead } from "../../state/use-recovering-read";
import { CloudRepositoryPicker, type CloudRepositorySelection } from "./cloud-repository-picker";
import { SettingsActions, SettingsField, SettingsGroup, SettingsRow, SettingsSection } from "./settings-ui";
import { cloudEnvironmentCache, cloudEnvironmentError, cloudEnvironmentKey, readCloudEnvironment,
  saveCloudEnvironment, saveCloudEnvironmentFile } from "./cloud-environment-api";
import { readEnvironmentSelection, saveEnvironmentSelection } from "./environment-selection";

export function EnvironmentPanel({ surfaceActive = true }: { surfaceActive?: boolean }) {
  const organization = useActiveOrganization(), { me } = useTeams();
  const member = (me?.organizations ?? me?.teams ?? []).find(row => row.id === organization?.id);
  if (!isFeatureEnabled("cloud-workspaces") || !organization || organization.isPersonal || !me || !member?.workspaceCapabilities.cloud)
    return <UserEnvironmentPanel />;
  return surfaceActive ? <EnvironmentScope key={`${me.user.id}:${getOrganizationStoreGeneration()}:${organization.id}`}
    userId={me.user.id} organizationId={organization.id} active={surfaceActive} /> : null;
}

function EnvironmentScope({ userId, organizationId, active }: { userId: string; organizationId: string; active: boolean }) {
  const [selection, setSelection] = useState(() => readEnvironmentSelection(userId, organizationId));
  const lifetime = useRef(new AbortController());
  useLayoutEffect(() => {
    if (lifetime.current.signal.aborted) { lifetime.current = new AbortController(); setSelection(current => ({ ...current })); }
    return () => lifetime.current.abort();
  }, []);
  const select = (scope: "local" | "cloud", repository = selection.repository) => {
    lifetime.current.abort(); lifetime.current = new AbortController();
    const next = { scope, repository }; saveEnvironmentSelection(userId, organizationId, next); setSelection(next);
  };
  return <Tabs value={selection.scope} onValueChange={value => select(value === "cloud" ? "cloud" : "local")}>
    <TabsList aria-label="Environment location"><TabsTrigger value="local">Local</TabsTrigger><TabsTrigger value="cloud">Cloud</TabsTrigger></TabsList>
    <TabsContent value="local"><UserEnvironmentPanel /></TabsContent>
    <TabsContent value="cloud" className="mt-6">
      <div className="flex flex-col gap-6">
        <SettingsSection title="Cloud environment" description="Private defaults for cloud workspaces you create. Changes apply to new workspaces; existing workspaces keep their saved version.">
          <CloudRepositoryPicker userId={userId} organizationId={organizationId} active={active && selection.scope === "cloud"}
            value={selection.repository ? [selection.repository] : []} onChange={rows => select("cloud", rows[0] ?? null)} />
        </SettingsSection>
        {active && selection.scope === "cloud" && selection.repository && <CloudEnvironmentEditor
          key={`${selection.repository.id}:${selection.repository.owner}/${selection.repository.name}`}
          organizationId={organizationId} repository={selection.repository} signal={lifetime.current.signal} />}
      </div>
    </TabsContent>
  </Tabs>;
}

export function CloudEnvironmentEditor({ organizationId, repository, signal }: {
  organizationId: string; repository: CloudRepositorySelection; signal: AbortSignal;
}) {
  const key = cloudEnvironmentKey(organizationId, repository);
  const snapshot = useRecoveringRead(cloudEnvironmentCache, key, readCloudEnvironment, { maxAgeMs: 30_000 });
  const [name, setName] = useState(""), [value, setValue] = useState(""), [path, setPath] = useState(".env.local");
  const [file, setFile] = useState<File | null>(null), [fileGeneration, setFileGeneration] = useState(0);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [clearing, setClearing] = useState(false);
  const lifetime = useRef(new AbortController());
  const valueInput = useRef<HTMLInputElement>(null), running = useRef(false);
  useLayoutEffect(() => {
    if (lifetime.current.signal.aborted) lifetime.current = new AbortController();
    return () => lifetime.current.abort();
  }, []);
  const current = () => !signal.aborted && !lifetime.current.signal.aborted;
  const run = async (action: (signal: AbortSignal) => Promise<unknown>, done?: () => void) => {
    if (!current() || running.current || !snapshot.data || snapshot.readError) return;
    running.current = true; setBusy(true); setError(null);
    try {
      await action(AbortSignal.any([signal, lifetime.current.signal]));
      if (current()) done?.();
    } catch (cause) {
      if (current()) { setError(cloudEnvironmentError(cause)); snapshot.refresh(); }
    } finally { running.current = false; if (current()) setBusy(false); }
  };
  const revision = snapshot.data?.revision ?? 0, disabled = busy || !snapshot.data || !!snapshot.readError;
  const replace = (next: string) => { setName(next); setValue(""); valueInput.current?.focus(); };
  return <div className="flex flex-col gap-6">
    <p className="text-fg2 text-xs">Values are write-only. Agents, setup and terminals in your workspace can read them. They are never copied to the shared Cloud Computer.</p>
    {snapshot.loading && <p className="text-fg2 text-xs" role="status">Loading environment…</p>}
    {(error || snapshot.error) && <p className="text-red-primary text-xs" role="alert">{error ?? cloudEnvironmentError(snapshot.error)}</p>}
    <SettingsGroup title="Application variables" description="Up to 128 variables, 16 KiB per value. Runtime and provider names are reserved.">
      {snapshot.data?.variables.map(variable => <SettingsRow key={variable.name} label={variable.name} hint={`${variable.bytes} bytes · Value saved`}>
        <div className="flex gap-2"><Button variant="ghost" disabled={disabled} onClick={() => replace(variable.name)} aria-label={`Replace ${variable.name}`}>Replace</Button>
          <Button variant="ghost" disabled={disabled} onClick={() => void run(s => saveCloudEnvironment(key, { expectedRevision: revision, variables: { [variable.name]: null } }, s))} aria-label={`Remove ${variable.name}`}>Remove</Button></div>
      </SettingsRow>)}
      <SettingsField label="Variable name" htmlFor="cloud-environment-name"><Input id="cloud-environment-name" placeholder="APP_API_KEY" value={name} disabled={busy} autoComplete="off" spellCheck={false} maxLength={128} onChange={event => setName(event.target.value)} /></SettingsField>
      <SettingsField label="New value" htmlFor="cloud-environment-value" hint="Saving the same name replaces its value."><Input id="cloud-environment-value" ref={valueInput} type="password" autoComplete="new-password" spellCheck={false} value={value} disabled={busy} onChange={event => setValue(event.target.value)} /></SettingsField>
      <SettingsActions><Button disabled={disabled || !name} onClick={() => void run(s => saveCloudEnvironment(key, { expectedRevision: revision, variables: { [name]: value } }, s), () => { setName(""); setValue(""); })}>Save variable</Button></SettingsActions>
    </SettingsGroup>
    <SettingsGroup title="Environment files" description="Choose up to 16 .env files, 64 KiB each. The destination must be untracked and ignored by Git; existing files are never replaced during initial setup.">
      {snapshot.data?.files.map(saved => <SettingsRow key={saved.path} label={saved.path} hint={`${saved.bytes} bytes · Contents saved`}>
        <div className="flex gap-2"><Button variant="ghost" disabled={disabled} onClick={() => { setPath(saved.path); setFile(null); setFileGeneration(g => g + 1); }} aria-label={`Replace ${saved.path}`}>Replace</Button>
          <Button variant="ghost" disabled={disabled} onClick={() => void run(s => saveCloudEnvironment(key, { expectedRevision: revision, files: [{ path: saved.path, content: null }] }, s))} aria-label={`Remove ${saved.path}`}>Remove</Button></div>
      </SettingsRow>)}
      <SettingsField label="Destination path" htmlFor="cloud-environment-path"><Input id="cloud-environment-path" placeholder="config/.env.local" autoComplete="off" spellCheck={false} value={path} disabled={busy} onChange={event => setPath(event.target.value)} /></SettingsField>
      <SettingsField label="Choose file" htmlFor="cloud-environment-file"><Input key={fileGeneration} id="cloud-environment-file" type="file" disabled={busy} onChange={event => setFile(event.target.files?.[0] ?? null)} /></SettingsField>
      <SettingsActions><Button disabled={disabled || !file || !path} onClick={() => { const selected = file; if (selected) void run(s => saveCloudEnvironmentFile(key, revision, path, selected, s), () => { setFile(null); setFileGeneration(g => g + 1); }); }}>Save file</Button></SettingsActions>
    </SettingsGroup>
    <SettingsActions><Button variant="ghost" onClick={snapshot.refresh} disabled={busy}>Refresh</Button>
      <Button variant="ghost" disabled={disabled || !snapshot.data?.versionId} onClick={() => setClearing(true)}>Clear cloud defaults</Button></SettingsActions>
    <Dialog open={clearing} onOpenChange={setClearing}><DialogContent><DialogHeader><DialogTitle>Clear cloud defaults?</DialogTitle>
      <DialogDescription>New workspaces will have no saved variables or environment files. Existing workspaces keep their pinned version.</DialogDescription></DialogHeader><DialogBody />
      <DialogFooter><Button variant="secondary" onClick={() => setClearing(false)}>Cancel</Button><Button disabled={disabled} onClick={() => void run(s => saveCloudEnvironment(key, { expectedRevision: revision, clear: true }, s), () => { setClearing(false); setName(""); setValue(""); setFile(null); setFileGeneration(g => g + 1); })}>Clear defaults</Button></DialogFooter>
    </DialogContent></Dialog>
  </div>;
}
