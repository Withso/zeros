import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Plus } from "lucide-react";
import { Button } from "../../shared/ui/primitives/button";
import { Badge } from "../../shared/ui/primitives/badge";
import { MessageRow } from "../../shared/ui/primitives/message-row";
import { Tabs, TabsList, TabsTrigger } from "../../shared/ui/primitives/tabs";
import { toast } from "../../shared/ui/primitives/elements";
import { useRecoveringRead } from "../../state/use-recovering-read";
import { KeyedAsyncCache } from "../../shared/lib/keyed-async-cache";
import { shellOpenUrl } from "../../platform/app";
import type { OrganizationSummary } from "../team/control-plane";
import { isFeatureEnabled } from "../../config/release-channel";
import { mcpConnectionCache, mcpConnectionKey, rememberMcpConnection } from "./mcp-connection-status";
import { McpServerEditor, type McpProbeResult, type McpProjectOption } from "./mcp-server-editor";
import { saveMcpDraft, secretChangesFromDraft } from "./mcp-form-save";
import { serverFromDraft, type Draft } from "./mcp-server-model";
import type { RawServer } from "./mcp-server-model";
import { mcpConnectionView } from "./mcp-connection-view";
import { SettingsAddRow, SettingsGroup, SettingsList, SettingsRow } from "../settings/settings-ui";
import { McpServerRow } from "./mcp-server-row";
import { readCloudMcpRepositories, cancelCloudMcpAuth, cloudMcpAuthStatus, cloudMcpCache, cloudMcpKey, probeCloudMcp, readCloudMcp, removeCloudMcp, saveCloudMcp, startCloudMcpAuth, type CloudMcpExtension } from "./mcp-cloud-api";

const repositoriesCache = new KeyedAsyncCache<McpProjectOption[]>(24);

const TRANSPORT_LABEL = { stdio: "STDIO", sse: "Legacy SSE", http: "Streamable HTTP" } as const;

function OrganizationMcpRow({ row, ownerKey, observedAt, busy, onEdit, onConnect, onToggle, onRemove }: {
  row: CloudMcpExtension; ownerKey: string; observedAt: number; busy: boolean; onEdit: () => void; onConnect: () => void;
  onToggle: (enabled: boolean) => void; onRemove: () => void;
}) {
  const key = mcpConnectionKey(ownerKey, row.config, row);
  const verification = useSyncExternalStore(useCallback(listener => mcpConnectionCache.subscribe(key, listener), [key]), useCallback(() => mcpConnectionCache.getSnapshot(key), [key]));
  const checked = row.config.auth !== "oauth" || !row.oauth || verification.updatedAt >= observedAt ? verification.data : undefined;
  const view = mcpConnectionView(row.config, checked, row.config.auth === "oauth" ? row.oauth?.status : undefined);
  const name = String(row.config.name);
  const transport = row.config.transport === "stdio" ? "stdio" : row.config.transport === "sse" ? "sse" : "http";
  // Status shows only when the server needs the person.
  const tone = view.tone === "warning" ? "warning" as const : view.tone === "error" ? "failure" as const
    : view.label === "Needs connection" ? "neutral" as const : null;
  return <McpServerRow
    transport={transport}
    name={name}
    hint={`${row.repository ?? "All projects"} · ${TRANSPORT_LABEL[transport]}`}
    status={tone ? <Badge variant={tone}>{view.label}</Badge> : null}
    action={view.action && view.label !== "Connected"
      ? <Button variant="secondary" size="compact" disabled={busy} onClick={onConnect}>{view.tone === "error" ? "Retry" : "Connect"}</Button>
      : null}
    toggle={row.canEdit ? { checked: row.config.enabled !== false, onCheckedChange: onToggle, disabled: busy } : undefined}
    onOpen={{ label: `Edit ${name}`, onClick: onEdit }}
    menu={{ disabled: busy, items: [
      { label: row.canEdit ? "Edit" : "View", onSelect: onEdit },
      ...(row.canEdit ? [{ label: "Remove", onSelect: onRemove, destructive: true }] : []),
    ] }}
  />;
}

export function OrganizationMcpPage({ organization, surfaceActive }: { organization: OrganizationSummary; surfaceActive: boolean }) {
  const cloudEnabled = isFeatureEnabled("cloud-workspaces");
  const [githubPlacement, setGithubPlacement] = useState<"local" | "cloud">("local");
  const key = cloudMcpKey(organization.id, githubPlacement);
  const read = useRecoveringRead(cloudMcpCache, key, readCloudMcp, { enabled: surfaceActive, maxAgeMs: 30_000 });
  const repositories = useRecoveringRead(repositoriesCache, key, readCloudMcpRepositories, { enabled: surfaceActive, maxAgeMs: 30_000 });
  const [view, setView] = useState<{ kind: "list" } | { kind: "editor"; initial: CloudMcpExtension | null; connect?: boolean; owner?: "organization" | "user" }>({ kind: "list" });
  const canShare = organization.role === "owner" || organization.role === "admin";
  const servers = read.data;
  const [busy, setBusy] = useState<string | null>(null);
  const mutating = useRef(false);
  const mounted = useRef(true);
  const refreshServers = read.refresh;
  const refreshRepositories = repositories.refresh;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!surfaceActive) return;
    const refresh = () => { refreshServers(); refreshRepositories(); };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [surfaceActive, refreshServers, refreshRepositories]);
  const mutate = async (row: CloudMcpExtension, remove: boolean, enabled?: boolean) => {
    if (mutating.current) return;
    mutating.current = true; setBusy(row.id);
    try {
      if (remove) await removeCloudMcp(key, row);
      else await saveCloudMcp(key, { id: row.id, owner: row.owner, repository: row.repository, expectedRevision: row.revision, config: { ...row.config, enabled } });
      if (mounted.current) read.refresh();
    } catch (error) {
      if (mounted.current) { toast.error(error instanceof Error ? error.message : "Could not update this MCP server."); read.refresh(); }
    } finally { mutating.current = false; if (mounted.current) setBusy(null); }
  };
  return <div className="bg-bg1 flex h-full min-h-0 w-full flex-col overflow-y-auto px-6" {...(!surfaceActive ? { inert: "" } : {})}>
    {/* The Settings shell: one centered 640px column, one title. */}
    <div className="mx-auto flex w-full max-w-160 flex-col gap-8 pt-10 pb-12">
      {view.kind === "editor" ? <OrganizationMcpEditor key={view.initial?.id ?? `new:${view.owner ?? ""}`} initial={view.initial} organization={organization}
        defaultOwner={view.owner} ownerKey={key} projects={repositories.data ?? []} projectsLoading={!repositories.data && !repositories.error}
        servers={read.data ?? []} surfaceActive={surfaceActive} connectOnOpen={view.connect ?? false} onBack={() => { setView({ kind: "list" }); read.refresh(); }} />
        : <>
          <header className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 flex-col gap-1">
              <h1 className="text-fg1 m-0 text-lg leading-6 font-medium">MCP servers</h1>
              <p className="text-fg2 m-0 text-xs leading-4.5">Tools and services for {organization.name}.</p>
            </div>
            <Button variant="primary" size="compact" className="shrink-0" onClick={() => setView({ kind: "editor", initial: null })}><Plus aria-hidden="true" />Add server</Button>
          </header>
          {cloudEnabled && <SettingsList>
            <SettingsRow label="Repository connection" hint="Where repository servers run.">
              <Tabs value={githubPlacement} onValueChange={value => setGithubPlacement(value === "cloud" ? "cloud" : "local")}>
                <TabsList aria-label="GitHub connection for repository selection">
                  <TabsTrigger value="local">On this Mac</TabsTrigger>
                  <TabsTrigger value="cloud">Cloud</TabsTrigger>
                </TabsList>
              </Tabs>
            </SettingsRow>
          </SettingsList>}
          {repositories.error && <MessageRow tone="warning" flush>{repositories.error.message}</MessageRow>}
          {/* Until the first read lands, one row says so for the whole page. */}
          {!servers ? <SettingsList>
            {read.error ? <MessageRow tone="error" role="alert" flush
              actions={<Button variant="ghost" size="compact" onClick={read.refresh}>Retry</Button>}>Couldn’t load MCP servers.</MessageRow>
              : <MessageRow tone="pending" role="status" flush>Loading MCP servers…</MessageRow>}
          </SettingsList> : (["organization", "user"] as const).map(owner => {
            const rows = servers.filter(row => row.owner === owner);
            const shared = owner === "organization";
            // An empty group says so, unless its one action (the add row) does.
            const addRow = shared ? rows.length === 0 && canShare : true;
            return <SettingsGroup key={owner} aria-label={shared ? "Shared servers" : "Your servers"}
              title={shared ? "Shared by your organization" : "Your servers"}
              description={shared ? "Members sign in with their own account." : `Only you can use these in ${organization.name}.`}>
              {rows.length === 0 && !(shared && canShare) && <p className="text-fg2 m-0 text-xs leading-4.5">
                {shared ? "No shared servers yet." : "No servers of your own yet."}</p>}
              {rows.map(row => <OrganizationMcpRow key={row.id} row={row} ownerKey={key} observedAt={read.updatedAt} busy={busy !== null}
                onEdit={() => setView({ kind: "editor", initial: row })} onConnect={() => setView({ kind: "editor", initial: row, connect: true })}
                onToggle={enabled => void mutate(row, false, enabled)} onRemove={() => void mutate(row, true)} />)}
              {addRow && <SettingsAddRow label={shared ? "Add a shared server" : "Add your own server"}
                onClick={() => setView({ kind: "editor", initial: null, owner })} />}
            </SettingsGroup>;
          })}
        </>}
    </div>
  </div>;
}

function OrganizationMcpEditor({ initial: source, organization, defaultOwner, ownerKey, projects, projectsLoading, servers, onBack, surfaceActive, connectOnOpen }: {
  initial: CloudMcpExtension | null; organization: OrganizationSummary; defaultOwner?: "organization" | "user"; ownerKey: string; projects: readonly McpProjectOption[];
  projectsLoading: boolean; servers: CloudMcpExtension[]; onBack: () => void; surfaceActive: boolean; connectOnOpen: boolean;
}) {
  const [initial, setInitial] = useState(source);
  const definition = useRef(initial);
  definition.current = initial;
  const canShare = organization.role === "owner" || organization.role === "admin";
  const [owner, setOwner] = useState<"organization" | "user">(() => initial?.owner ?? (defaultOwner === "user" || !canShare ? "user" : "organization"));
  const [project, setProject] = useState(initial?.repository ?? "all");
  const [id] = useState(() => initial?.id ?? crypto.randomUUID());
  const verificationKey = initial ? mcpConnectionKey(ownerKey, initial.config, initial) : "new-organization-mcp";
  const verification = useSyncExternalStore(useCallback(listener => mcpConnectionCache.subscribe(verificationKey, listener), [verificationKey]), useCallback(() => mcpConnectionCache.getSnapshot(verificationKey), [verificationKey]));
  const [connected, setConnected] = useState(() => initial ? initial.config.auth === "oauth"
    ? initial.oauth?.status === "connected"
    : mcpConnectionCache.getSnapshot(mcpConnectionKey(ownerKey, initial.config, initial)).data?.status === "connected" : false);
  const [connecting, setConnecting] = useState(false);
  const auth = useRef<{ abort: AbortController; attemptId?: string } | null>(null);
  const cancel = useCallback(() => {
    const pending = auth.current; auth.current = null;
    if (!pending) return;
    pending.abort.abort();
    if (pending.attemptId) void cancelCloudMcpAuth(ownerKey, pending.attemptId).catch(() => {});
  }, [ownerKey]);
  useEffect(() => {
    if (!surfaceActive) { cancel(); setConnecting(false); }
    return cancel;
  }, [surfaceActive, cancel]);
  const connect = async (config: RawServer) => {
    const saved = definition.current;
    if (!saved || !surfaceActive || auth.current) return;
    if (saved.config !== config) throw new Error("This server changed. Reopen it before connecting.");
    const pending = { abort: new AbortController(), attemptId: undefined as string | undefined };
    auth.current = pending; setConnecting(true);
    try {
      const started = await startCloudMcpAuth(ownerKey, saved, pending.abort.signal);
      pending.attemptId = started.attemptId;
      if (auth.current !== pending) { void cancelCloudMcpAuth(ownerKey, started.attemptId).catch(() => {}); return; }
      await shellOpenUrl(started.authorizationUrl);
      const expires = Math.min(Date.now() + 10 * 60_000, started.expiresAt);
      while (auth.current === pending && Date.now() < expires) {
        const result = await cloudMcpAuthStatus(ownerKey, started.attemptId, pending.abort.signal);
        if (auth.current !== pending || pending.abort.signal.aborted) return;
        if (result.status === "failed") throw new Error(result.message || "Sign-in could not complete. Try connecting again.");
        if (result.status === "connected") {
          rememberMcpConnection(ownerKey, saved.config, { status: "connected", stages: [] }, saved);
          setConnected(true); cloudMcpCache.invalidate(ownerKey); toast.success("MCP server connected"); return;
        }
        await new Promise<void>((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(new Error("Sign-in cancelled")); };
          const timer = setTimeout(() => { pending.abort.signal.removeEventListener("abort", abort); resolve(); }, 1500);
          pending.abort.signal.addEventListener("abort", abort, { once: true });
        });
      }
      if (auth.current === pending) throw new Error("Sign-in expired. Connect again to continue.");
    } catch (error) {
      if (auth.current === pending && !pending.abort.signal.aborted) toast.error(error instanceof Error ? error.message : "Could not connect this MCP server.");
    } finally { if (auth.current === pending) { cancel(); setConnecting(false); } }
  };
  const onSave = useCallback(async (draft: Draft, verification?: McpProbeResult) => {
    const repository = project === "all" ? null : project;
    if (repository && !projects.some(row => row.value === repository)) throw new Error("Choose a repository available to this organisation.");
    let saved!: CloudMcpExtension;
    await saveMcpDraft({ draft, initial: initial?.config ?? null,
      takenNames: new Set(servers.filter(row => row.id !== id && row.owner === owner && row.repository === repository).map(row => String(row.config.name))),
      persist: async (config, secrets) => { cancel(); saved = await saveCloudMcp(ownerKey, { id, owner, repository, expectedRevision: initial?.revision ?? null, config, secrets }); rememberMcpConnection(ownerKey, saved.config, verification, saved); },
    });
    definition.current = saved; setInitial(saved);
    setConnected(saved.config.auth === "oauth" ? saved.oauth?.status === "connected" : verification?.status === "connected");
    return saved.config;
  }, [project, projects, initial, servers, id, owner, ownerKey, cancel]);
  const onVerified = useCallback((draft: Draft, result: McpProbeResult) => {
    if (initial && mcpConnectionKey(ownerKey, serverFromDraft(draft, initial.config), initial) === mcpConnectionKey(ownerKey, initial.config, initial)) {
      rememberMcpConnection(ownerKey, initial.config, result, initial);
      if (initial.config.auth !== "oauth") setConnected(result.status === "connected");
    }
  }, [initial, ownerKey]);
  const probe = useCallback((draft: Draft, signal: AbortSignal) => probeCloudMcp(ownerKey,
    serverFromDraft({ ...draft, name: draft.name.trim() || "connection-check" }, initial?.config ?? null), secretChangesFromDraft(draft), initial, signal), [ownerKey, initial]);
  return <McpServerEditor initial={initial?.config ?? null} target={{ identity: ownerKey, organization: true, owner, project, projects, canShare,
    loading: projectsLoading, ...(!initial ? { onOwnerChange: setOwner, onProjectChange: setProject } : {}),
  }} onSave={onSave} onBack={onBack} probe={probe} onVerified={onVerified} surfaceActive={surfaceActive} readOnly={initial ? !initial.canEdit : false} connectOnOpen={connectOnOpen}
    savedConnection={{ status: connected ? "connected" : "needs-connection", connecting,
      tools: verification.data?.tools, verification: verification.data ?? undefined,
      onConnect: connect, onCancel: () => { cancel(); setConnecting(false); },
    }} />;
}
