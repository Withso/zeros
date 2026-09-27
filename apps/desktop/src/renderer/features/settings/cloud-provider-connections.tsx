import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType } from "react";
import { Button, Input } from "../../shared/ui";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../shared/ui/primitives/select";
import { Checkbox } from "../../shared/ui/primitives/checkbox";
import { toast } from "../../shared/ui/primitives/elements";
import { useTeams, type TeamStoreState } from "../team/team-store";
import { getCloudWorkspaceRows, subscribeCloudWorkspaces, cloudWorkspaceDocument } from "../../state/cloud-workspace-catalog";
import { selectActiveFolder, useWorkspaceStore } from "../../state/store";
import { parseCloudWorkspaceKey } from "../../platform/bridge/cloud-workspace-key";
import type { BridgeRegistryAgent } from "../../platform/bridge/messages";
import { invalidateCloudAgentRegistry, useWorkspaceAgents, warmCloudAgentRegistry } from "../agent/workspace-agent-registry";
import { modelsForAgent } from "../agent/model-catalog";
import { AgentIcon } from "../agent/agent-icon";
import { useCachedRead } from "../../state/use-cached-read";
import { ProviderConnectionDialog } from "./provider-connection-dialog";
import type { ConnectionMethod } from "./connection-methods";
import { authorizeCloudProvider, cloudProviderAccessCache, cloudProviderCredentialsCache, disconnectCloudProvider,
  readCloudProviderAccess, readCloudProviderCredentials, saveCloudProviderCredential, type CloudProviderCredential } from "./cloud-provider-connection";

type Tabs = ComponentType<{ providers: BridgeRegistryAgent[]; activeId: string; onSelect: (id: string) => void }>;

export function CloudProviderConnections({ organizationId, surfaceActive, Tabs }: {
  organizationId: string; surfaceActive: boolean; Tabs: Tabs;
}) {
  const { me } = useTeams();
  const rows = useSyncExternalStore(subscribeCloudWorkspaces, getCloudWorkspaceRows);
  const activeFolder = useWorkspaceStore(selectActiveFolder);
  const [selected, setSelected] = useState<string | null>(null);
  const [agentId, setAgentId] = useState("claude");
  const workspaces = useMemo(() => rows.filter(row => row.organizationId === organizationId && row.archivedAt == null), [organizationId, rows]);
  const folder = workspaces.find(row => row.path === selected)?.path ?? workspaces.find(row => row.path === activeFolder)?.path ?? workspaces[0]?.path ?? null;
  const registry = useWorkspaceAgents(folder, surfaceActive);
  const agents = folder ? (registry ?? []) : [];
  const agent = agents.find(row => row.id === agentId) ?? agents[0];
  return <div className="flex flex-col gap-8">
    <div className="flex items-center justify-between gap-3">
      <span className="text-fg2 text-xs">Workspace</span>
      <Select value={folder ?? ""} onValueChange={setSelected} disabled={!workspaces.length}>
        <SelectTrigger aria-label="Cloud agent workspace"><SelectValue placeholder="Create a cloud workspace first" /></SelectTrigger>
        <SelectContent>{workspaces.map(row => <SelectItem key={row.path} value={row.path}>{cloudWorkspaceDocument(parseCloudWorkspaceKey(row.path)!)?.name ?? row.branch}</SelectItem>)}</SelectContent>
      </Select>
    </div>
    {!folder ? <p className="text-fg2 text-xs">Create a cloud workspace to connect its agents.</p>
      : !agent ? <p className="text-fg2 text-xs">Start this workspace to load its agents.</p>
        : <><Tabs providers={agents} activeId={agent.id} onSelect={setAgentId} />
          {me && <CloudProviderConnection key={`${me.user.id}:${folder}:${agent.id}`} folder={folder} agent={agent} user={me.user} surfaceActive={surfaceActive} />}</>}
  </div>;
}

function CloudProviderConnection({ folder, agent, user, surfaceActive }: {
  folder: string; agent: BridgeRegistryAgent; user: NonNullable<TeamStoreState["me"]>["user"]; surfaceActive: boolean;
}) {
  const target = parseCloudWorkspaceKey(folder)!;
  const key = JSON.stringify([user.id, target.organizationId, target.workspaceId]);
  const credentials = useCachedRead(cloudProviderCredentialsCache, user.id, readCloudProviderCredentials, { enabled: surfaceActive, maxAgeMs: 30_000 });
  const access = useCachedRead(cloudProviderAccessCache, key, () => readCloudProviderAccess(target.workspaceId), { enabled: surfaceActive, maxAgeMs: 15_000 });
  const [open, setOpen] = useState(false);
  const [method, setMethod] = useState<ConnectionMethod>("apiKey");
  const [selected, setSelected] = useState("new");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const models = useMemo(() => modelsForAgent(agent.id, null).filter(row => row.value.length <= 256 && /^[A-Za-z0-9][A-Za-z0-9._:/-]*(?:\[1m\])?$/.test(row.value)), [agent.id]);
  const [allowedModels, setAllowedModels] = useState(() => models.slice(0, 32).map(row => row.value));
  const createIntent = useRef<{ token: string; method: ConnectionMethod; id: string; operationId: string } | null>(null);
  const grantIntent = useRef<Parameters<typeof authorizeCloudProvider>[0] | null>(null);
  const matching = (credentials.data ?? []).filter(row => !row.revoked && row.kind.startsWith(`${agent.id}-`));
  const grants = (access.data?.delegations ?? []).filter(row => row.kind.startsWith(`${agent.id}-`) && Date.parse(row.expiresAt) > Date.now());
  useEffect(() => { if (!surfaceActive) { setOpen(false); setToken(""); createIntent.current = null; } }, [surfaceActive]);
  const refresh = async () => {
    cloudProviderCredentialsCache.invalidate(user.id);
    cloudProviderAccessCache.invalidate(key);
    await Promise.all([credentials.refresh(), access.refresh()]);
    invalidateCloudAgentRegistry(folder);
    await warmCloudAgentRegistry(folder).catch(() => {});
  };
  const connect = async () => {
    if (inFlight.current || !allowedModels.length || !access.data) return;
    if (access.data.compute.trust !== "zeros-managed") { toast.error("Agent connection for this compute host is not available yet."); return; }
    inFlight.current = true; setBusy(true);
    try {
      let chosen: CloudProviderCredential | undefined = matching.find(row => row.id === selected);
      if (selected === "new") {
        if (!token.trim()) return;
        if (createIntent.current?.token !== token.trim() || createIntent.current.method !== method)
          createIntent.current = { token: token.trim(), method, id: crypto.randomUUID(), operationId: crypto.randomUUID() };
        chosen = (await saveCloudProviderCredential({ ...createIntent.current, displayName: `${agent.name} cloud connection`, agentId: agent.id, setupToken: method === "account" })).credential;
        cloudProviderCredentialsCache.setData(user.id, [chosen, ...(credentials.data ?? []).filter(row => row.id !== chosen!.id)]);
        setSelected(chosen.id); setToken(""); createIntent.current = null;
      }
      if (!chosen) throw new Error("Select a cloud credential.");
      const fingerprint = access.data.compute;
      if (!grantIntent.current || grantIntent.current.credentialId !== chosen.id || grantIntent.current.expectedRevision !== chosen.revision ||
        JSON.stringify(grantIntent.current.models) !== JSON.stringify(allowedModels) || grantIntent.current.computeConsent.fingerprint !== fingerprint.fingerprint)
        grantIntent.current = { id: crypto.randomUUID(), credentialId: chosen.id, expectedRevision: chosen.revision,
          workspaceId: target.workspaceId, granteeUserId: user.id, models: allowedModels,
          expiresAt: new Date(Date.now() + 7 * 24 * 3600_000).toISOString(), computeConsent: fingerprint };
      await authorizeCloudProvider(grantIntent.current);
      grantIntent.current = null;
      await refresh(); setOpen(false); toast.success(`${agent.name} connected to this cloud workspace`);
    } catch (error) { toast.error(error instanceof Error ? error.message : "Cloud connection failed"); }
    finally { inFlight.current = false; setBusy(false); }
  };
  const disconnect = async () => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true);
    try {
      for (const grant of grants.filter(row => row.ownerUserId === user.id)) await disconnectCloudProvider(grant.id);
      await refresh(); toast.success("Disconnected from this workspace");
    } catch (error) { toast.error(error instanceof Error ? error.message : "Disconnect failed"); }
    finally { inFlight.current = false; setBusy(false); }
  };
  return <section className="flex flex-col gap-3">
    <div className="flex items-center justify-between gap-4">
      <div className="text-fg1 flex items-center gap-3 text-sm font-medium"><AgentIcon agentId={agent.id} iconUrl={null} className="size-5" />{agent.name}</div>
      <Button variant="secondary" size="lg" onClick={() => setOpen(true)}>{grants.length ? "Connected" : "Connect"}</Button>
    </div>
    <p className="text-fg2 text-xs">Cloud credentials are authorized for your account in this workspace.</p>
    {(access.error || credentials.error) && <p className="text-error text-xs" role="alert">{access.error?.message ?? credentials.error?.message}</p>}
    <ProviderConnectionDialog provider={agent.id} name={agent.name} open={surfaceActive && open} onOpenChange={value => { setOpen(value); if (!value) { setToken(""); createIntent.current = null; } }}
      method={method} onMethodChange={value => { setMethod(value); setToken(""); createIntent.current = null; }} connected={grants.length > 0} busy={busy}
      methodOptions={[{ id: "apiKey", label: "API", description: "Connect a cloud API key." }, ...(agent.id === "claude" ? [{ id: "account" as const, label: "Setup token", description: "Paste a Claude setup token for cloud execution." }] : [])]}>
      <Select value={selected} onValueChange={setSelected} disabled={busy}>
        <SelectTrigger aria-label="Cloud credential"><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="new">New cloud credential</SelectItem>{matching.map(row => <SelectItem value={row.id} key={row.id}>{row.displayName}</SelectItem>)}</SelectContent>
      </Select>
      {selected === "new" && <Input type="password" autoComplete="off" aria-label={method === "account" ? "Cloud setup token" : "Cloud API key"} placeholder={method === "account" ? "Paste setup token" : "Paste API key"} value={token} onChange={event => setToken(event.target.value)} disabled={busy} />}
      <p className="text-fg2 text-xs">Authorize these models for seven days. The credential is stored encrypted in cloud and used on Zeros Cloud.</p>
      <div className="flex max-h-48 flex-col gap-2 overflow-y-auto">{models.map(model => <label key={model.value} className="text-fg1 flex items-center gap-2 text-xs">
        <Checkbox checked={allowedModels.includes(model.value)} disabled={busy || (!allowedModels.includes(model.value) && allowedModels.length >= 32)} onChange={() => setAllowedModels(values => values.includes(model.value) ? values.filter(value => value !== model.value) : [...values, model.value])} />{model.label}
      </label>)}</div>
      <div className="flex justify-end gap-2">
        {grants.some(row => row.ownerUserId === user.id) && <Button variant="secondary" disabled={busy} onClick={() => void disconnect()}>Disconnect workspace</Button>}
        <Button disabled={busy || !access.data || allowedModels.length === 0 || (selected === "new" && !token.trim())} onClick={() => void connect()}>{busy ? "Connecting…" : "Authorize workspace"}</Button>
      </div>
    </ProviderConnectionDialog>
  </section>;
}
