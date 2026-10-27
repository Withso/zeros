import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ChevronRight, Plus, Trash2 } from "lucide-react";
import { Button } from "../../shared/ui/primitives/button";
import { Switch } from "../../shared/ui/primitives/switch";
import { toast } from "../../shared/ui/primitives/elements";
import { useCachedRead } from "../../state/use-cached-read";
import { KeyedAsyncCache } from "../../shared/lib/keyed-async-cache";
import { shellOpenUrl } from "../../platform/app";
import type { OrganizationSummary } from "../team/control-plane";
import { mcpConnectionCache, mcpConnectionKey, rememberMcpConnection } from "./mcp-connection-status";
import { McpServerEditor, type McpProbeResult, type McpProjectOption } from "./mcp-server-editor";
import { saveMcpDraft, secretChangesFromDraft } from "./mcp-form-save";
import { serverFromDraft, type Draft } from "./mcp-server-model";
import type { RawServer } from "./mcp-server-model";
import { mcpConnectionView } from "./mcp-connection-view";
import { SETTINGS_CARD_LIST_CLS, SETTINGS_GROUP_RADIUS } from "../settings/settings-ui";
import { readCloudMcpRepositories, cancelCloudMcpAuth, cloudMcpAuthStatus, cloudMcpCache, cloudMcpKey, probeCloudMcp, readCloudMcp, removeCloudMcp, saveCloudMcp, startCloudMcpAuth, type CloudMcpExtension } from "./mcp-cloud-api";

const repositoriesCache = new KeyedAsyncCache<McpProjectOption[]>(24);

function OrganizationMcpRow({ row, ownerKey, observedAt, busy, onEdit, onConnect, onToggle, onRemove }: {
  row: CloudMcpExtension; ownerKey: string; observedAt: number; busy: boolean; onEdit: () => void; onConnect: () => void;
  onToggle: (enabled: boolean) => void; onRemove: () => void;
}) {
  const key = mcpConnectionKey(ownerKey, row.config, row);
  const verification = useSyncExternalStore(useCallback(listener => mcpConnectionCache.subscribe(key, listener), [key]), useCallback(() => mcpConnectionCache.getSnapshot(key), [key]));
  const checked = row.config.auth !== "oauth" || !row.oauth || verification.updatedAt >= observedAt ? verification.data : undefined;
  const view = mcpConnectionView(row.config, checked, row.config.auth === "oauth" ? row.oauth?.status : undefined);
  return <div className="flex flex-wrap items-center gap-3 py-3">
    <Button variant="ghost" className="h-auto min-w-0 flex-1 justify-between gap-4 px-0 py-1 text-left" onClick={onEdit} aria-label={`Edit ${String(row.config.name)}`}>
      <span className="flex min-w-0 flex-col gap-1"><span className="text-fg1 truncate text-xs">{String(row.config.name)}</span><span className="text-fg2 truncate text-xs">{row.repository ?? "All projects"} · {row.config.transport === "stdio" ? "STDIO" : row.config.transport === "sse" ? "Legacy SSE" : "Streamable HTTP"}</span></span>
      <ChevronRight className="text-fg3 size-4" aria-hidden="true" />
    </Button>
    <span className={view.tone === "success" ? "text-green-primary text-xs" : view.tone === "error" ? "text-red-primary text-xs" : "text-fg2 text-xs"}>{view.label}</span>
    {view.action && view.label !== "Connected" && <Button variant="secondary" disabled={busy} onClick={onConnect}>{view.tone === "error" ? "Retry" : "Connect"}</Button>}
    {row.canEdit && <><Switch aria-label={`Enable ${String(row.config.name)}`} checked={row.config.enabled !== false} disabled={busy} onCheckedChange={onToggle} />
      <Button variant="ghost" size="icon" aria-label={`Remove ${String(row.config.name)}`} disabled={busy} onClick={onRemove}><Trash2 aria-hidden="true" /></Button></>}
  </div>;
}

export function OrganizationMcpPage({ organization, surfaceActive }: { organization: OrganizationSummary; surfaceActive: boolean }) {
  const key = cloudMcpKey(organization.id);
  const read = useCachedRead(cloudMcpCache, key, readCloudMcp, { enabled: surfaceActive, maxAgeMs: 30_000 });
  const repositories = useCachedRead(repositoriesCache, key, readCloudMcpRepositories, { enabled: surfaceActive, maxAgeMs: 30_000 });
  const [view, setView] = useState<{ kind: "list" } | { kind: "editor"; initial: CloudMcpExtension | null; connect?: boolean }>({ kind: "list" });
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
  return <div className="bg-bg1 flex h-full min-h-0 w-full flex-col overflow-y-auto" {...(!surfaceActive ? { inert: "" } : {})}>
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 pt-10 pb-12">
      {view.kind === "editor" ? <OrganizationMcpEditor key={view.initial?.id ?? "new"} initial={view.initial} organization={organization}
        ownerKey={key} projects={repositories.data ?? []} projectsLoading={!repositories.data && !repositories.error}
        servers={read.data ?? []} surfaceActive={surfaceActive} connectOnOpen={view.connect ?? false} onBack={() => { setView({ kind: "list" }); read.refresh(); }} />
        : <>
          <div className="flex items-start justify-between gap-4"><div className="flex flex-col gap-1">
            <h1 className="text-fg1 m-0 text-lg font-medium">MCP servers</h1>
            <p className="text-fg2 m-0 text-xs">Connect tools and services for {organization.name}.</p>
          </div><Button variant="default" onClick={() => setView({ kind: "editor", initial: null })}><Plus aria-hidden="true" />Add server</Button></div>
          {!read.data && <p className="text-fg3 m-0 text-sm" role="status">{read.error ? "Could not load MCP servers. Reopen this page to try again." : "Loading MCP servers…"}</p>}
          {(["organization", "user"] as const).map(owner => {
            const rows = (read.data ?? []).filter(row => row.owner === owner);
            return <section className="flex flex-col gap-3" key={owner} aria-label={owner === "organization" ? "Shared servers" : "Your servers"}>
              <div className="flex flex-col gap-1"><h2 className="text-fg2 m-0 text-3xxs font-medium">{owner === "organization" ? "Shared by your organisation" : "Your servers"}</h2>
                <p className="text-fg3 m-0 text-xs">{owner === "organization" ? "Available to members. Each person connects their own account when sign-in is required." : "Only you can use these servers in this organisation."}</p></div>
              <div className={`${SETTINGS_CARD_LIST_CLS} ${SETTINGS_GROUP_RADIUS} flex flex-col divide-y`}>
                {rows.length === 0 ? <p className="text-fg2 m-0 py-4 text-xs">No MCP servers yet.</p> : rows.map(row => <OrganizationMcpRow key={row.id} row={row} ownerKey={key} observedAt={read.updatedAt} busy={busy !== null}
                  onEdit={() => setView({ kind: "editor", initial: row })} onConnect={() => setView({ kind: "editor", initial: row, connect: true })}
                  onToggle={enabled => void mutate(row, false, enabled)} onRemove={() => void mutate(row, true)} />)}
              </div>
            </section>;
          })}
        </>}
    </div>
  </div>;
}

function OrganizationMcpEditor({ initial: source, organization, ownerKey, projects, projectsLoading, servers, onBack, surfaceActive, connectOnOpen }: {
  initial: CloudMcpExtension | null; organization: OrganizationSummary; ownerKey: string; projects: readonly McpProjectOption[];
  projectsLoading: boolean; servers: CloudMcpExtension[]; onBack: () => void; surfaceActive: boolean; connectOnOpen: boolean;
}) {
  const [initial, setInitial] = useState(source);
  const definition = useRef(initial);
  definition.current = initial;
  const canShare = organization.role === "owner" || organization.role === "admin";
  const [owner, setOwner] = useState<"organization" | "user">(() => initial?.owner ?? (canShare ? "organization" : "user"));
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
