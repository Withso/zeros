import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronRight, FileUp, Plus, Trash2, X } from "lucide-react";
import { Input, Textarea } from "../../shared/ui";
import { Button } from "../../shared/ui/primitives/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../shared/ui/primitives/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger, toast } from "../../shared/ui/primitives/elements";
import { ZerosSpinner } from "../../shared/ui/loading";
import { MCP_IMPORT_MAX_BYTES, parseMcpConfiguration } from "./mcp-configuration-import";
import { mcpUrlError, nextKvId, secureDraftFromServer, type Draft, type KV, type OAuthClientMode, type RawServer } from "./mcp-server-model";
import { McpToolsSection } from "./mcp-tools-section";
import { SettingsField, SettingsGroup, SettingsRow } from "../settings/settings-ui";
import { mcpDraftError } from "./mcp-form-save";
import { mcpConnectionView } from "./mcp-connection-view";

/** Ephemeral draft comparison, including write-only edits but excluding row IDs. */
function connectionDraftKey(draft: Draft): string {
  const { name: _name, description: _description, argsText: _argsText, disabledTools: _disabledTools, env, headers, ...connection } = draft;
  const values = (rows: KV[]) => rows.map(({ id: _id, ...row }) => row);
  return JSON.stringify([connection, values(env), values(headers)]);
}

export interface McpProbeResult {
  status: "connected" | "needs-auth" | "failed";
  stages: { stage: "validation" | "transport" | "initialize" | "tools"; status: "passed" | "failed" | "needs-auth" }[];
  toolCount?: number;
  tools?: string[];
  protocolVersion?: string;
  message?: string;
}
export interface McpProjectOption { value: string; label: string }
export interface McpSavedConnection {
  status: "connected" | "needs-connection" | "needs-auth" | "error";
  tools?: string[];
  verification?: McpProbeResult;
  connecting?: boolean;
  onConnect?: (server: RawServer) => Promise<void>;
  onCancel?: () => void;
}
export interface McpEditorTarget {
  identity: string;
  organization: boolean;
  owner: "organization" | "user";
  project: string;
  projects: readonly McpProjectOption[];
  onOwnerChange?: (owner: "organization" | "user") => void;
  onProjectChange?: (project: string) => void;
  loading?: boolean;
  canShare?: boolean;
}

const OAUTH_CLIENTS: { value: OAuthClientMode; label: string; description: string }[] = [
  { value: "auto", label: "Automatic", description: "Use Zeros’ published identity when supported, or register a client automatically." },
  { value: "metadata", label: "Zeros’ published identity", description: "The server reads Zeros’ public client information. No client credentials to enter." },
  { value: "dynamic", label: "Register automatically", description: "Register a client with the service when you sign in." },
  { value: "custom", label: "Your own client", description: "Use an OAuth client you registered with the service." },
];

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return <SettingsGroup title={title} description={description} aria-label={title}>{children}</SettingsGroup>;
}
const Field = SettingsField;
function SelectRow({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return <SettingsRow label={label} hint={hint} className="flex-wrap [&>div:last-child]:min-w-0 [&>div:last-child]:max-w-full">{children}</SettingsRow>;
}

function KeyValueFields({ kind, rows, onChange }: { kind: "variable" | "header"; rows: KV[]; onChange: (rows: KV[]) => void }) {
  return <div className="flex flex-col gap-2">
    {rows.map((row, index) => <div className="flex items-center gap-2" key={row.id}>
      <Input aria-label={`${kind === "variable" ? "Variable" : "Header"} name ${index + 1}`} placeholder={kind === "variable" ? "Name" : "Header name"}
        value={row.key} spellCheck={false} autoComplete="off" className="text-fg1 min-w-0 flex-1 font-sans text-xs"
        onChange={event => onChange(rows.map(entry => entry.id === row.id ? { ...entry, key: event.target.value } : entry))} />
      <Input aria-label={`${kind === "variable" ? "Variable" : "Header"} value ${index + 1}`} type="password" autoComplete="new-password" spellCheck={false}
        placeholder={row.stored ? "Saved value" : "Value"} value={row.value} className="text-fg1 min-w-0 flex-1 font-sans text-xs"
        onChange={event => onChange(rows.map(entry => entry.id === row.id ? { ...entry, value: event.target.value } : entry))} />
      <Button variant="ghost" size="icon" aria-label={`Remove ${kind} ${index + 1}`} onClick={() => onChange(rows.filter(entry => entry.id !== row.id))}>
        <Trash2 aria-hidden="true" />
      </Button>
    </div>)}
    <Button variant="secondary" onClick={() => onChange([...rows, { id: nextKvId(), key: "", value: "", secret: true, stored: false }])}>
      <Plus aria-hidden="true" />Add {kind}
    </Button>
  </div>;
}

function ConnectionDetails({ result }: { result?: McpProbeResult }) {
  if (!result?.stages.length) return null;
  const names = { validation: "Configuration", transport: "Server reached", initialize: "MCP connection", tools: "Tools loaded" };
  return <Collapsible>
    <CollapsibleTrigger asChild><Button variant="ghost" size="compact" className="text-fg2 group px-0">Connection details<ChevronRight className="group-data-[state=open]:rotate-90" aria-hidden="true" /></Button></CollapsibleTrigger>
    <CollapsibleContent className="pt-2"><div className="flex flex-col gap-2">
      {result.stages.map((row, index) => <div key={`${row.stage}-${index}`} className="text-fg2 flex items-center justify-between gap-4 text-xs">
        <span className="flex items-center gap-2">{row.status === "passed" ? <Check className="text-green-primary size-3.5" aria-hidden="true" />
          : row.status === "failed" ? <X className="text-red-primary size-3.5" aria-hidden="true" /> : <span className="bg-border3 size-1.5 rounded-full" aria-hidden="true" />}{names[row.stage]}</span>
        <span>{row.status === "passed" ? "Done" : row.status === "failed" ? "Failed" : "Needs authentication"}</span>
      </div>)}
    </div></CollapsibleContent>
  </Collapsible>;
}

export function McpServerEditor({ initial, target, onSave, onBack, onSaved = onBack, probe, onVerified, savedConnection, readOnly = false, surfaceActive = true, connectOnOpen = false }: {
  initial: RawServer | null;
  target: McpEditorTarget;
  onSave: (draft: Draft, verification?: McpProbeResult) => Promise<RawServer>;
  onVerified?: (draft: Draft, result: McpProbeResult) => void;
  onBack: () => void;
  onSaved?: () => void;
  probe?: (draft: Draft, signal: AbortSignal) => Promise<McpProbeResult>;
  savedConnection?: McpSavedConnection;
  readOnly?: boolean;
  surfaceActive?: boolean;
  connectOnOpen?: boolean;
}) {
  const id = useId();
  const [draft, setDraft] = useState(() => secureDraftFromServer(initial));
  const [args, setArgs] = useState(() => (draft.args ?? []).map(value => ({ id: nextKvId(), value })));
  const [busy, setBusy] = useState(false);
  const saving = useRef<symbol | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const active = useRef(surfaceActive);
  active.current = surfaceActive;
  const operation = useRef(0);
  useEffect(() => () => { operation.current++; }, [surfaceActive, target.identity]);
  const [clientExpanded, setClientExpanded] = useState(() => draft.oauthMode === "custom");
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [candidates, setCandidates] = useState<RawServer[]>([]);
  const [candidateIndex, setCandidateIndex] = useState("0");
  const fileInput = useRef<HTMLInputElement>(null);
  const importGeneration = useRef(0);
  const [probeAttempt, setProbeAttempt] = useState(0);
  const requestedProbe = useRef<{ key: string; action: "connect" | "test" | "refresh" } | null>(null);
  useEffect(() => { if (!surfaceActive) requestedProbe.current = null; }, [surfaceActive]);
  const connectAfterProbe = useRef<(() => void) | null>(null);
  const [connection, setConnection] = useState<{ key: string; configurationKey: string; checking?: boolean; result?: McpProbeResult } | null>(null);
  const [catalog, setCatalog] = useState<{ key: string; tools: string[] } | null>(null);
  // Keep dormant input in the draft when changing methods, but never send it
  // with a No sign-in request or save.
  const effectiveDraft = useMemo(() => ({ ...draft, args: args.map(row => row.value),
    headers: draft.auth === "none" || draft.transport === "stdio" ? [] : draft.headers,
  }), [draft, args]);
  const initialDraft = useMemo(() => secureDraftFromServer(initial), [initial]);
  const connectionChanged = Boolean(initial && connectionDraftKey(effectiveDraft) !== connectionDraftKey(initialDraft));
  const hasChanges = !initial || connectionChanged || draft.name !== initialDraft.name || draft.description !== initialDraft.description
    || JSON.stringify(draft.disabledTools) !== JSON.stringify(initialDraft.disabledTools);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft(current => ({ ...current, [key]: value }));
  const configurationKey = JSON.stringify([target.identity, target.owner, target.project, connectionDraftKey(effectiveDraft),
    draft.auth === "oauth" ? savedConnection?.status === "connected" : undefined]);
  const probeKey = JSON.stringify([configurationKey, probeAttempt]);
  const currentProbeKey = useRef(probeKey);
  currentProbeKey.current = probeKey;
  const requestProbe = (action: "connect" | "test" | "refresh") => {
    const error = mcpDraftError({ ...effectiveDraft, name: effectiveDraft.name.trim() || "connection-check" });
    if (error) { toast.error(error); return; }
    requestedProbe.current = { key: configurationKey, action };
    setProbeAttempt(value => value + 1);
  };
  const latestDraft = useRef(effectiveDraft);
  latestDraft.current = effectiveDraft;
  useEffect(() => {
    if (!probe || !surfaceActive || busy || savedConnection?.connecting || initial?.enabled === false || draft.transport === "stdio" || !draft.url.trim()
      || mcpDraftError({ ...latestDraft.current, name: latestDraft.current.name.trim() || "connection-check" })) return;
    const abort = new AbortController();
    const action = requestedProbe.current?.key === configurationKey ? requestedProbe.current.action : undefined;
    const timer = setTimeout(() => {
      requestedProbe.current = null;
      const checkedDraft = latestDraft.current;
      setConnection(previous => ({ key: probeKey, configurationKey, checking: true,
        ...(previous?.configurationKey === configurationKey ? { result: previous.result } : {}),
      }));
      const finish = (result: McpProbeResult) => {
        if (abort.signal.aborted || !active.current || currentProbeKey.current !== probeKey) return;
        setConnection({ key: probeKey, configurationKey, result });
        if (result.status === "connected" && result.tools !== undefined) setCatalog({ key: configurationKey, tools: result.tools });
        if (!connectionChanged) onVerified?.(checkedDraft, result);
        if (action === "connect" && result.status === "needs-auth" && checkedDraft.auth !== "header") connectAfterProbe.current?.();
        else if (action && result.status === "failed") toast.error("Could not connect to this MCP server. Check the connection details and try again.");
      };
      void probe(checkedDraft, abort.signal).then(finish).catch(() => finish({ status: "failed", stages: [] }));
    }, action ? 0 : 600);
    return () => { clearTimeout(timer); abort.abort(); };
  // The serialized configuration key includes every probe input, including
  // write-only edits, without retriggering for names or tool policy.
  }, [probe, probeKey, configurationKey, draft.transport, draft.url, surfaceActive, busy, onVerified, connectionChanged, savedConnection?.connecting, initial?.enabled]);

  const fill = (server: RawServer) => {
    const next = secureDraftFromServer(server);
    setDraft(next); setArgs((next.args ?? []).map(value => ({ id: nextKvId(), value })));
    setClientExpanded(next.oauthMode === "custom");
  };
  const parse = () => {
    const result = parseMcpConfiguration(importText);
    if (result.error) { toast.error(result.error); return; }
    for (const warning of result.warnings) toast.warning(warning);
    setCandidates(result.servers); setCandidateIndex("0"); fill(result.servers[0]);
    setImportText(""); importGeneration.current++;
    toast.success(result.servers.length > 1 ? "Choose a server to review before adding it." : "Configuration parsed. Review the details and add the server.");
  };
  const readFile = async (file: File) => {
    if (file.size > MCP_IMPORT_MAX_BYTES) { toast.error("Configuration must be smaller than 256 KB."); return; }
    const generation = ++importGeneration.current;
    try { const text = await file.text(); if (mounted.current && generation === importGeneration.current) setImportText(text); }
    catch { if (mounted.current && generation === importGeneration.current) toast.error("Could not read this configuration file."); }
  };
  const result = connection?.configurationKey === configurationKey ? connection.result
    : !connectionChanged ? savedConnection?.verification : undefined;
  const tools = catalog?.key === configurationKey ? catalog.tools : !connectionChanged ? savedConnection?.tools : undefined;
  const canProbe = Boolean(probe && draft.transport !== "stdio" && draft.url.trim() && !mcpUrlError(draft.url));
  const checking = connection?.key === probeKey && Boolean(connection.checking);
  const view = mcpConnectionView({ ...initial, transport: draft.transport, auth: draft.auth }, result,
    !connectionChanged ? savedConnection?.status : undefined);
  const selectedClient = OAUTH_CLIENTS.find(row => row.value === draft.oauthMode) ?? OAUTH_CLIENTS[0];
  const needsSaveToConnect = hasChanges || effectiveDraft.auth !== "oauth";
  const canAuthorize = Boolean(savedConnection?.onConnect && (!readOnly || (!needsSaveToConnect && draft.auth === "oauth")));

  const save = async (connect = false, useOAuth = false) => {
    if (saving.current || !active.current || savedConnection?.connecting) return;
    const next = useOAuth ? { ...effectiveDraft, auth: "oauth" as const } : effectiveDraft;
    const write = !connect || hasChanges || next.auth !== effectiveDraft.auth;
    if (readOnly && write) { toast.error("Ask the server’s owner to update its authentication settings."); return; }
    const saveAttempt = Symbol();
    saving.current = saveAttempt;
    const releaseSave = () => {
      if (saving.current !== saveAttempt) return;
      saving.current = null;
      if (mounted.current) setBusy(false);
    };
    const generation = operation.current;
    const current = () => mounted.current && active.current && generation === operation.current;
    if (write) setBusy(true);
    try {
      let saved = initial;
      if (write) {
        const checked = next.auth === effectiveDraft.auth ? result : undefined;
        saved = await onSave(next, checked && tools !== undefined ? { ...checked, tools } : checked);
        if (!current()) return;
        fill(saved);
      }
      if (!current()) return;
      // The auth owner has its own cancellable flight. A cancelled browser
      // RPC may settle late; it must not keep the save lock or block Retry.
      releaseSave();
      if (connect && saved) await savedConnection?.onConnect?.(saved);
      else { toast.success(initial ? "MCP server saved" : "MCP server added"); onSaved(); }
    } catch (error) {
      if (current()) toast.error(error instanceof Error ? error.message : "Could not save the MCP server.");
    } finally { releaseSave(); }
  };
  connectAfterProbe.current = () => { if (canAuthorize) void save(true, true); };
  const runConnection = () => {
    if (view.action === "connect") void save(true, true);
    else requestProbe(view.label === "Connected" ? "test" : "connect");
  };
  const requestedConnection = useRef(false);
  const latestConnect = useRef(runConnection);
  latestConnect.current = runConnection;
  useEffect(() => {
    if (!connectOnOpen || requestedConnection.current || !surfaceActive || (target.loading && !initial) || initial?.enabled === false) return;
    requestedConnection.current = true;
    latestConnect.current();
  }, [connectOnOpen, surfaceActive, target.loading, initial]);
  const connectLabel = view.action === "connect" ? needsSaveToConnect && (hasChanges || !initial) ? "Save & connect" : "Connect"
    : view.label === "Connected" ? "Check connection" : view.tone === "error" ? "Retry" : "Connect";
  const statusClass = view.tone === "success" ? "text-green-primary" : view.tone === "error" ? "text-red-primary" : view.tone === "warning" ? "text-yellow-primary" : "text-fg1";
  return <div className="flex min-w-0 flex-col gap-6" {...(!surfaceActive ? { inert: "" } : {})}>
    <nav aria-label="Breadcrumb" className="text-fg3 flex items-center gap-1 text-xs">
      <Button variant="ghost" size="compact" onClick={onBack} disabled={busy}>MCP</Button><ChevronRight className="size-3.5" aria-hidden="true" />
      <span>{initial ? "Edit server" : "Add server"}</span>
    </nav>
    <div className="bg-bg1 sticky top-0 z-1 flex flex-wrap items-start justify-between gap-3 py-3">
      <div className="flex flex-col gap-1"><h1 className="text-fg1 m-0 text-lg font-medium">{initial ? "Edit MCP server" : "Add MCP server"}</h1>
        <p className="text-fg2 m-0 text-xs">Connect tools and services your agents can use.</p></div>
      {!readOnly && <Button variant="default" onClick={() => void save()} disabled={busy || target.loading || savedConnection?.connecting}>
        {busy && <ZerosSpinner className="size-3.5" />}{initial ? "Save changes" : "Add server"}</Button>}
    </div>
    {(initial || canProbe) && <Section title="Connection">
      <SelectRow label={<span className={statusClass} role="status" aria-live="polite">{savedConnection?.connecting ? "Connecting…" : view.label}</span>}
        hint={savedConnection?.connecting ? "Finish signing in in your browser. You can cancel and try again."
          : checking ? <span className="flex items-center gap-2"><ZerosSpinner className="size-3.5" />Checking connection…</span>
            : view.action === "connect" && !canAuthorize ? "Ask the server’s owner to enable sign-in for this connection." : view.hint}>
        {savedConnection?.connecting ? <Button variant="secondary" onClick={savedConnection.onCancel}>Cancel</Button>
          : view.action && (view.action !== "connect" || canAuthorize) && <Button variant="secondary" disabled={busy || checking || !canProbe || Boolean(target.loading && !initial)} onClick={runConnection}>{connectLabel}</Button>}
      </SelectRow>
      {result && <div><ConnectionDetails result={result} /></div>}
    </Section>}
    <fieldset disabled={busy || readOnly || savedConnection?.connecting} className="m-0 flex min-w-0 flex-col gap-6 border-0 p-0">
      <Section title="Server">
        <Field label="Name" htmlFor={`${id}-name`}><Input id={`${id}-name`} autoFocus value={draft.name} onChange={event => set("name", event.target.value)} placeholder="e.g. context7" className="text-fg1 font-sans text-xs" autoComplete="off" /></Field>
        <SelectRow label="Owner" hint={target.organization ? target.owner === "organization" ? "Shared with members of this organisation." : "Only you can use this server in this organisation." : "Available to you on this device."}>
          {target.organization && target.onOwnerChange ? <Select value={target.owner} onValueChange={value => target.onOwnerChange?.(value as "organization" | "user")}>
            <SelectTrigger aria-label="Owner" className="min-w-40"><SelectValue /></SelectTrigger><SelectContent>
              <SelectItem value="organization" disabled={!target.canShare}>Organisation</SelectItem><SelectItem value="user">You</SelectItem>
            </SelectContent></Select> : <span className="text-fg2 text-xs">{target.organization && target.owner === "organization" ? "Organisation" : "You"}</span>}
        </SelectRow>
        <SelectRow label="Project" hint="Use in all projects, or only one.">
          {target.onProjectChange ? <Select value={target.project} onValueChange={target.onProjectChange} disabled={target.loading}>
            <SelectTrigger aria-label="Project" className="min-w-40 max-w-full"><SelectValue /></SelectTrigger><SelectContent>
              <SelectItem value="all">All projects</SelectItem>{target.projects.map(project => <SelectItem value={project.value} key={project.value}>{project.label}</SelectItem>)}
            </SelectContent>
          </Select> : <span className="text-fg2 text-xs">{target.project === "all" ? "All projects" : target.projects.find(row => row.value === target.project)?.label ?? target.project}</span>}
        </SelectRow>
      </Section>
      <Section title="Runtime">
        <SelectRow label="Transport" hint={draft.transport === "stdio" ? "Run a command where the agent runs." : "Connect to a remote MCP server."}>
          <Select value={draft.transport} onValueChange={value => set("transport", value as "stdio" | "http")}>
            <SelectTrigger aria-label="Transport" className="min-w-40"><SelectValue>{draft.transport === "sse" ? "Legacy SSE" : undefined}</SelectValue></SelectTrigger>
            <SelectContent><SelectItem value="stdio">STDIO</SelectItem><SelectItem value="http">Streamable HTTP</SelectItem></SelectContent>
          </Select>
        </SelectRow>
        {draft.transport === "stdio" ? <>
          <Field label="Command to launch" htmlFor={`${id}-command`}><Input id={`${id}-command`} value={draft.command} onChange={event => set("command", event.target.value)} placeholder="npx" className="text-fg1 font-sans text-xs" spellCheck={false} /></Field>
          <Field label="Arguments"><div className="flex flex-col gap-2">{args.map((row, index) => <div className="flex items-center gap-2" key={row.id}>
            <Input aria-label={`Argument ${index + 1}`} value={row.value} onChange={event => setArgs(current => current.map(entry => entry.id === row.id ? { ...entry, value: event.target.value } : entry))} placeholder={index === 0 ? "--yes" : "Argument"} className="text-fg1 min-w-0 font-sans text-xs" spellCheck={false} />
            <Button variant="ghost" size="icon" aria-label={`Remove argument ${index + 1}`} onClick={() => setArgs(current => current.filter(entry => entry.id !== row.id))}><Trash2 aria-hidden="true" /></Button>
          </div>)}<Button variant="secondary" onClick={() => setArgs(current => [...current, { id: nextKvId(), value: "" }])}><Plus aria-hidden="true" />Add argument</Button></div></Field>
          <Field label="Working directory" htmlFor={`${id}-cwd`} hint="Optional. Relative paths start at the workspace folder."><Input id={`${id}-cwd`} value={draft.cwd} onChange={event => set("cwd", event.target.value)} placeholder="Workspace folder" className="text-fg1 font-sans text-xs" spellCheck={false} /></Field>
          <Field label="Also listens on" htmlFor={`${id}-listen`} hint="Optional. Use this local HTTP endpoint after launching the command."><Input id={`${id}-listen`} value={draft.listenUrl ?? ""} onChange={event => set("listenUrl", event.target.value)} placeholder="http://127.0.0.1:8080/mcp" className="text-fg1 font-sans text-xs" spellCheck={false} /></Field>
        </> : <Field label="URL" htmlFor={`${id}-url`}><Input id={`${id}-url`} value={draft.url} onChange={event => set("url", event.target.value)} placeholder="https://mcp.example.com/mcp" className="text-fg1 font-sans text-xs" spellCheck={false} autoComplete="off" /></Field>}
      </Section>
      {draft.transport !== "stdio" && <Section title="Authentication">
        <SelectRow label="Method" hint={draft.auth === "oauth" ? "Connect your account through the service’s sign-in page." : draft.auth === "header" ? "Send an API key or token in request headers." : "Connect without credentials."}>
          <Select value={draft.auth} onValueChange={value => set("auth", value as Draft["auth"])}>
            <SelectTrigger aria-label="Authentication" className="min-w-40"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="oauth">Sign in</SelectItem><SelectItem value="header">API key</SelectItem><SelectItem value="none">No sign-in</SelectItem></SelectContent>
          </Select>
        </SelectRow>
        {(draft.auth === "header" || (draft.auth === "oauth" && draft.headers.length > 0)) && <Field label="Headers" hint="Values are stored securely. Use ${NAME} to reference a variable.">
          <KeyValueFields kind="header" rows={draft.headers} onChange={rows => set("headers", rows)} />
        </Field>}
        {draft.auth === "oauth" && <Collapsible open={clientExpanded} onOpenChange={setClientExpanded}>
          <CollapsibleTrigger asChild><Button variant="ghost" className="text-fg2 group px-0">Advanced sign-in options<ChevronRight className="group-data-[state=open]:rotate-90" aria-hidden="true" /></Button></CollapsibleTrigger>
          <CollapsibleContent className="pt-3"><div className="flex flex-col gap-3">
            <SelectRow label="OAuth client" hint={selectedClient.description}>
              <Select value={draft.oauthMode ?? "auto"} onValueChange={value => set("oauthMode", value as OAuthClientMode)}>
                <SelectTrigger aria-label="OAuth client" className="min-w-40"><SelectValue /></SelectTrigger>
                <SelectContent>{OAUTH_CLIENTS.map(client => <SelectItem value={client.value} key={client.value}>{client.label}</SelectItem>)}</SelectContent>
              </Select>
            </SelectRow>
            {draft.oauthMode === "custom" && <>
              <Field label="Client ID" htmlFor={`${id}-client`}><Input id={`${id}-client`} value={draft.oauthClientId} onChange={event => set("oauthClientId", event.target.value)} placeholder="Registered client ID" className="text-fg1 font-sans text-xs" spellCheck={false} /></Field>
              <Field label="Client secret" htmlFor={`${id}-secret`}><Input id={`${id}-secret`} type="password" autoComplete="new-password" value={draft.oauthClientSecret} onChange={event => { set("oauthClientSecret", event.target.value); set("clearOAuthClientSecret", false); }} placeholder={initial ? "Leave blank to keep saved value" : "Optional"} className="text-fg1 font-sans text-xs" /></Field>
              {initial && <Button variant="ghost" onClick={() => { set("clearOAuthClientSecret", !draft.clearOAuthClientSecret); set("oauthClientSecret", ""); }}>{draft.clearOAuthClientSecret ? "Keep saved client secret" : "Remove saved client secret"}</Button>}
            </>}
            <Field label="Scopes" htmlFor={`${id}-scopes`} hint="Optional permissions, separated by spaces."><Input id={`${id}-scopes`} value={draft.oauthScopes} onChange={event => set("oauthScopes", event.target.value)} placeholder="Service defaults" className="text-fg1 font-sans text-xs" spellCheck={false} /></Field>
          </div></CollapsibleContent>
        </Collapsible>}
      </Section>}
      <Section title="Variables" description={draft.transport === "stdio" ? "Environment variables for this process. Values are stored securely." : "Optional values you can reference in headers with ${NAME}."}>
        <div><KeyValueFields kind="variable" rows={draft.env} onChange={rows => set("env", rows)} /></div>
      </Section>
      <Collapsible open={importOpen} onOpenChange={setImportOpen}>
        <CollapsibleTrigger asChild><Button variant="ghost" className="text-fg2 px-0"><span>Import a configuration</span>{importOpen ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}</Button></CollapsibleTrigger>
        <CollapsibleContent className="pt-3"><Section title="Import">
          <Field label="Configuration" htmlFor={`${id}-import`} hint="Paste MCP JSON, Codex TOML, a URL, or a command. You can also drop a configuration file.">
            <Textarea id={`${id}-import`} rows={6} value={importText} onChange={event => { importGeneration.current++; setImportText(event.target.value); }}
              placeholder={'{ "mcpServers": { … } } or npx -y my-mcp-server'} className="text-fg1 font-sans text-xs" spellCheck={false}
              onDragOver={event => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
              onDrop={event => { if (!event.dataTransfer.files.length) return; event.preventDefault(); void readFile(event.dataTransfer.files[0]); }} />
          </Field>
          {candidates.length > 1 && <div><Select value={candidateIndex} onValueChange={value => { setCandidateIndex(value); fill(candidates[Number(value)]); }}>
            <SelectTrigger aria-label="Server to import"><SelectValue /></SelectTrigger><SelectContent>{candidates.map((server, index) => <SelectItem value={String(index)} key={index}>{String(server.name)}</SelectItem>)}</SelectContent>
          </Select></div>}
          <div className="flex items-center justify-between gap-3"><Input ref={fileInput} type="file" className="sr-only" tabIndex={-1} accept=".json,.toml,.txt" aria-label="Configuration file" onChange={event => { const file = event.target.files?.[0]; if (file) void readFile(file); event.target.value = ""; }} />
            <Button variant="ghost" onClick={() => fileInput.current?.click()}><FileUp aria-hidden="true" />Choose file</Button>
            <Button variant="secondary" disabled={!importText.trim()} onClick={parse}>Parse</Button></div>
        </Section></CollapsibleContent>
      </Collapsible>
    </fieldset>
    {(initial || tools !== undefined) && <McpToolsSection key={configurationKey} tools={tools} disabledTools={draft.disabledTools ?? []}
      controlled={draft.transport !== "stdio" && (target.organization || draft.auth === "oauth" || draft.auth === "header")}
      editable={!readOnly && !busy && !savedConnection?.connecting} checking={checking}
      actionsDisabled={!canProbe || busy || Boolean(savedConnection?.connecting) || !surfaceActive || initial?.enabled === false}
      emptyHint={initial?.enabled === false ? "Enable this server to load its tools." : draft.transport === "stdio" ? "Tools are available when an agent starts this server."
        : "Connect this server to load its tools."}
      onChange={value => set("disabledTools", value)} onRefresh={() => requestProbe("refresh")} />}
  </div>;
}
