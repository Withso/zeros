import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronRight, FileUp, Plus, Trash2 } from "lucide-react";
import { Input, Textarea } from "../../shared/ui";
import { Button } from "../../shared/ui/primitives/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../shared/ui/primitives/select";
import { RadioGroup, RadioGroupItem } from "../../shared/ui/primitives/radio-group";
import { Collapsible, CollapsibleContent, CollapsibleTrigger, toast } from "../../shared/ui/primitives/elements";
import { ZerosSpinner } from "../../shared/ui/loading";
import { MCP_IMPORT_MAX_BYTES, parseMcpConfiguration } from "./mcp-configuration-import";
import { mcpUrlError, nextKvId, secureDraftFromServer, type Draft, type KV, type OAuthClientMode, type RawServer } from "./mcp-server-model";

/** Ephemeral draft comparison, including write-only edits but excluding row IDs. */
function connectionDraftKey(draft: Draft): string {
  const { name: _name, description: _description, argsText: _argsText, env, headers, ...connection } = draft;
  const values = (rows: KV[]) => rows.map(({ id: _id, ...row }) => row);
  return JSON.stringify([connection, values(env), values(headers)]);
}

export interface McpProbeResult {
  status: "connected" | "needs-auth" | "failed";
  stages: { stage: "validation" | "transport" | "initialize" | "tools"; status: "passed" | "failed" | "needs-auth" }[];
  toolCount?: number;
  protocolVersion?: string;
  message?: string;
}
export interface McpProjectOption { value: string; label: string }
export interface McpSavedConnection {
  status: "connected" | "needs-connection";
  connecting?: boolean;
  onConnect?: () => void;
  onCancel?: () => void;
}
export interface McpEditorTarget {
  organization: boolean;
  owner: "organization" | "user";
  project: string;
  projects: readonly McpProjectOption[];
  onOwnerChange?: (owner: "organization" | "user") => void;
  onProjectChange?: (project: string) => void;
  loading?: boolean;
  canShare?: boolean;
}

const CARD = "border-border1 bg-bg1-highlight flex flex-col gap-4 rounded-lg border p-4";
const OAUTH_CLIENTS: { value: OAuthClientMode; label: string; description: string }[] = [
  { value: "auto", label: "Automatic", description: "Use Zeros’ published identity when supported, or register a client automatically." },
  { value: "metadata", label: "Zeros’ published identity", description: "The server reads Zeros’ public client information. No client credentials to enter." },
  { value: "dynamic", label: "Register automatically", description: "Register a client with the service when you sign in." },
  { value: "custom", label: "Your own client", description: "Use an OAuth client you registered with the service." },
];

function Section({ title, description, children, action }: { title: string; description?: string; children: ReactNode; action?: ReactNode }) {
  return <section className="flex min-w-0 flex-col gap-3" aria-label={title}>
    <div className="flex items-center justify-between gap-3">
      <div className="flex flex-col gap-1"><h2 className="text-fg1 m-0 text-sm font-medium">{title}</h2>
        {description && <p className="text-fg3 m-0 text-xs leading-relaxed">{description}</p>}</div>{action}
    </div>{children}
  </section>;
}
function Field({ label, hint, children, htmlFor }: { label: string; hint?: string; children: ReactNode; htmlFor?: string }) {
  return <div className="flex min-w-0 flex-col gap-2"><label htmlFor={htmlFor} className="text-fg1 text-sm">{label}</label>{children}
    {hint && <p className="text-fg3 m-0 text-xs leading-relaxed">{hint}</p>}</div>;
}
function SelectRow({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <div className="flex flex-wrap items-center justify-between gap-3">
    <div className="flex min-w-0 flex-col gap-1"><span className="text-fg1 text-sm">{label}</span>{hint && <span className="text-fg3 text-xs">{hint}</span>}</div>
    <div className="min-w-0 max-w-full">{children}</div>
  </div>;
}

function KeyValueFields({ kind, rows, onChange }: { kind: "variable" | "header"; rows: KV[]; onChange: (rows: KV[]) => void }) {
  return <div className="flex flex-col gap-2">
    {rows.map((row, index) => <div className="flex items-center gap-2" key={row.id}>
      <Input aria-label={`${kind === "variable" ? "Variable" : "Header"} name ${index + 1}`} placeholder={kind === "variable" ? "Name" : "Header name"}
        value={row.key} spellCheck={false} autoComplete="off" className="text-fg1 min-w-0 flex-1 font-sans"
        onChange={event => onChange(rows.map(entry => entry.id === row.id ? { ...entry, key: event.target.value } : entry))} />
      <Input aria-label={`${kind === "variable" ? "Variable" : "Header"} value ${index + 1}`} type="password" autoComplete="new-password" spellCheck={false}
        placeholder={row.stored ? "Saved value" : "Value"} value={row.value} className="text-fg1 min-w-0 flex-1 font-sans"
        onChange={event => onChange(rows.map(entry => entry.id === row.id ? { ...entry, value: event.target.value } : entry))} />
      <Button variant="ghost" size="icon" aria-label={`Remove ${kind} ${index + 1}`} onClick={() => onChange(rows.filter(entry => entry.id !== row.id))}>
        <Trash2 aria-hidden="true" />
      </Button>
    </div>)}
    <Button variant="secondary" className="w-full" onClick={() => onChange([...rows, { id: nextKvId(), key: "", value: "", secret: true, stored: false }])}>
      <Plus aria-hidden="true" />Add {kind}
    </Button>
  </div>;
}

function ConnectionStatus({ state }: { state: { checking?: boolean; result?: McpProbeResult } }) {
  if (!state.checking && !state.result) return null;
  const names = { transport: "Connecting to the server", initialize: "Negotiating the protocol", tools: "Listing tools" } as const;
  return <div className="border-border1 flex flex-col gap-2 border-t pt-4" role="status" aria-live="polite">
    {state.checking ? <div className="text-fg3 flex items-center gap-2 text-xs"><ZerosSpinner className="size-3.5" />Checking connection…</div>
      : <>
        {(["transport", "initialize", "tools"] as const).map(stage => {
          const result = state.result?.stages.find(row => row.stage === stage);
          const status = result?.status === "passed" ? "Done" : result?.status === "needs-auth" ? "After sign-in" : "Not completed";
          return <div className="text-fg3 flex items-center justify-between gap-4 text-xs" key={stage}>
            <span className="flex items-center gap-2">{result?.status === "passed" ? <Check className="text-green-primary size-3.5" aria-hidden="true" /> : <span className="bg-border3 size-1.5 rounded-full" aria-hidden="true" />}{names[stage]}</span><span>{status}</span>
          </div>;
        })}
        <p className="text-fg2 m-0 text-xs">{state.result?.status === "connected" ? `Connected · ${state.result.toolCount ?? 0} tools available`
          : state.result?.status === "needs-auth" ? "Server found · sign-in required" : "Connection could not be verified"}
          {state.result?.protocolVersion ? ` · MCP ${state.result.protocolVersion}` : ""}</p>
      </>}
  </div>;
}

export function McpServerEditor({ initial, target, onSave, onBack, onSaved = onBack, probe, onVerified, savedConnection, readOnly = false, surfaceActive = true }: {
  initial: RawServer | null;
  target: McpEditorTarget;
  onSave: (draft: Draft, verification?: McpProbeResult) => Promise<void>;
  onVerified?: (draft: Draft, result: McpProbeResult) => void;
  onBack: () => void;
  onSaved?: () => void;
  probe?: (draft: Draft, signal: AbortSignal) => Promise<McpProbeResult>;
  savedConnection?: McpSavedConnection;
  readOnly?: boolean;
  surfaceActive?: boolean;
}) {
  const id = useId();
  const [draft, setDraft] = useState(() => secureDraftFromServer(initial));
  const [args, setArgs] = useState(() => (draft.args ?? []).map(value => ({ id: nextKvId(), value })));
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [clientExpanded, setClientExpanded] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [candidates, setCandidates] = useState<RawServer[]>([]);
  const [candidateIndex, setCandidateIndex] = useState("0");
  const fileInput = useRef<HTMLInputElement>(null);
  const importGeneration = useRef(0);
  const [probeAttempt, setProbeAttempt] = useState(0);
  const [connection, setConnection] = useState<{ key: string; checking?: boolean; result?: McpProbeResult } | null>(null);
  const effectiveDraft = useMemo(() => ({ ...draft, args: args.map(row => row.value) }), [draft, args]);
  const initialDraft = useMemo(() => secureDraftFromServer(initial), [initial]);
  const connectionChanged = Boolean(initial && connectionDraftKey(effectiveDraft) !== connectionDraftKey(initialDraft));
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft(current => ({ ...current, [key]: value }));
  const probeKey = JSON.stringify([target.owner, target.project, connectionDraftKey(effectiveDraft), probeAttempt,
    draft.auth === "oauth" ? savedConnection?.status : undefined]);
  const latestDraft = useRef(effectiveDraft);
  latestDraft.current = effectiveDraft;
  useEffect(() => {
    if (!probe || !surfaceActive || busy || savedConnection?.connecting || draft.transport === "stdio" || !draft.url.trim() || mcpUrlError(draft.url)) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      setConnection({ key: probeKey, checking: true });
      void probe(latestDraft.current, abort.signal).then(result => {
        if (!abort.signal.aborted) {
          setConnection({ key: probeKey, result });
          if (!connectionChanged) onVerified?.(latestDraft.current, result);
        }
      }).catch(() => {
        if (!abort.signal.aborted) setConnection({ key: probeKey, result: { status: "failed", stages: [] } });
      });
    }, 600);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [probe, probeKey, draft.transport, draft.url, surfaceActive, busy, onVerified, connectionChanged, savedConnection?.connecting]);

  const fill = (server: RawServer) => {
    const next = secureDraftFromServer(server);
    setDraft(next); setArgs((next.args ?? []).map(value => ({ id: nextKvId(), value })));
    setClientExpanded(false);
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
  const save = async () => {
    if (saving.current) return;
    saving.current = true; setBusy(true);
    try {
      await onSave(effectiveDraft, connection?.key === probeKey ? connection.result : undefined);
      if (mounted.current) { toast.success(initial ? "MCP server saved" : "MCP server added"); onSaved(); }
    } catch (error) {
      if (mounted.current) toast.error(error instanceof Error ? error.message : "Could not save the MCP server.");
    } finally { saving.current = false; if (mounted.current) setBusy(false); }
  };
  const selectedClient = OAUTH_CLIENTS.find(row => row.value === draft.oauthMode) ?? OAUTH_CLIENTS[0];
  const savedStatus = !connectionChanged && connection?.key === probeKey && connection.result
    ? connection.result.status === "connected" ? "connected" : "needs-connection" : savedConnection?.status;
  return <div className="flex min-w-0 flex-col gap-8" {...(!surfaceActive ? { inert: "" } : {})}>
    <nav aria-label="Breadcrumb" className="text-fg3 flex items-center gap-1 text-xs">
      <Button variant="ghost" size="compact" onClick={onBack} disabled={busy}>MCP</Button><ChevronRight className="size-3.5" aria-hidden="true" />
      <span>{initial ? "Edit server" : "Add server"}</span>
    </nav>
    <div className="flex flex-col gap-1"><h1 className="text-fg1 m-0 text-lg font-medium">{initial ? "Edit MCP server" : "Add MCP server"}</h1>
      <p className="text-fg3 m-0 text-sm">Connect tools and services your agents can use.</p></div>
    {savedConnection && <Section title="Connection"><div className={CARD}>
      <SelectRow label="Status" hint={savedStatus === "connected" ? "The last connection check succeeded." : draft.transport === "stdio" ? "This process connects when an agent starts in the selected project." : draft.auth === "oauth" ? "Connect your account to make this server available to your agents." : "Check this server’s connection before your agents use it."}>
        <div className="flex items-center gap-3">
          <span className={savedStatus === "connected" ? "bg-green-bg text-green-fg rounded-md px-2 py-1 text-xs" : "bg-yellow-bg text-yellow-fg rounded-md px-2 py-1 text-xs"}>
            {savedStatus === "connected" ? "Connected" : "Needs connection"}
          </span>
          {savedConnection.connecting ? <Button variant="secondary" onClick={savedConnection.onCancel}><ZerosSpinner className="size-3.5" />Cancel</Button>
            : savedConnection.onConnect && <Button variant="secondary" disabled={Boolean(connectionChanged) || busy} onClick={savedConnection.onConnect}>Connect</Button>}
          {!savedConnection.onConnect && probe && draft.transport !== "stdio" && <Button variant="secondary" onClick={() => setProbeAttempt(value => value + 1)}>Test connection</Button>}
        </div>
      </SelectRow>
      {connectionChanged && <p className="text-fg3 m-0 text-xs">Save your changes before connecting.</p>}
    </div></Section>}
    <fieldset disabled={busy || readOnly || savedConnection?.connecting} className="m-0 flex min-w-0 flex-col gap-8 border-0 p-0">
      <Section title="Server" action={!readOnly && <Button variant="default" onClick={() => void save()} disabled={busy || target.loading}>
        {busy && <ZerosSpinner className="size-3.5" />}{initial ? "Save changes" : "Add server"}</Button>}>
        <div className={CARD}>
          <Field label="Name" htmlFor={`${id}-name`}><Input id={`${id}-name`} autoFocus value={draft.name} onChange={event => set("name", event.target.value)} placeholder="e.g. context7" className="text-fg1 font-sans" autoComplete="off" /></Field>
          <div className="border-border1 flex flex-col gap-4 border-t pt-4">
            <SelectRow label="Owner" hint={target.organization ? target.owner === "organization" ? "Available to members of this organisation." : "Only you can use this server in this organisation." : "Available to you on this device."}>
              {target.organization ? <Select value={target.owner} onValueChange={value => target.onOwnerChange?.(value as "organization" | "user")} disabled={!target.onOwnerChange}>
                <SelectTrigger aria-label="Owner" className="min-w-40"><SelectValue /></SelectTrigger><SelectContent>
                  <SelectItem value="organization" disabled={!target.canShare}>Organisation</SelectItem><SelectItem value="user">You</SelectItem>
                </SelectContent></Select> : <span className="text-fg2 text-sm">You</span>}
            </SelectRow>
            <div className="border-border1 border-t pt-4"><SelectRow label="Project" hint="Available in every project, or only in one.">
              <Select value={target.project} onValueChange={target.onProjectChange} disabled={!target.onProjectChange || target.loading}>
                <SelectTrigger aria-label="Project" className="min-w-40 max-w-full"><SelectValue /></SelectTrigger><SelectContent>
                  <SelectItem value="all">All projects</SelectItem>{target.projects.map(project => <SelectItem value={project.value} key={project.value}>{project.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </SelectRow></div>
          </div>
        </div>
      </Section>
      <Section title="Runtime"><div className={CARD}>
        <SelectRow label="Transport" hint={draft.transport === "stdio" ? "Launch a process on the machine running the agent." : "Connect to an MCP server over HTTP."}>
          <Select value={draft.transport} onValueChange={value => set("transport", value as "stdio" | "http")}>
            <SelectTrigger aria-label="Transport" className="min-w-40"><SelectValue>{draft.transport === "sse" ? "Legacy SSE" : undefined}</SelectValue></SelectTrigger>
            <SelectContent><SelectItem value="stdio">STDIO</SelectItem><SelectItem value="http">Streamable HTTP</SelectItem></SelectContent>
          </Select>
        </SelectRow>
        <div className="border-border1 flex flex-col gap-4 border-t pt-4">
          {draft.transport === "stdio" ? <>
            <Field label="Command to launch" htmlFor={`${id}-command`}><Input id={`${id}-command`} value={draft.command} onChange={event => set("command", event.target.value)} placeholder="npx" className="text-fg1 font-sans" spellCheck={false} /></Field>
            <Field label="Arguments"><div className="flex flex-col gap-2">{args.map((row, index) => <div className="flex items-center gap-2" key={row.id}>
              <Input aria-label={`Argument ${index + 1}`} value={row.value} onChange={event => setArgs(current => current.map(entry => entry.id === row.id ? { ...entry, value: event.target.value } : entry))} placeholder={index === 0 ? "--yes" : "Argument"} className="text-fg1 min-w-0 font-sans" spellCheck={false} />
              <Button variant="ghost" size="icon" aria-label={`Remove argument ${index + 1}`} onClick={() => setArgs(current => current.filter(entry => entry.id !== row.id))}><Trash2 aria-hidden="true" /></Button>
            </div>)}<Button variant="secondary" className="w-full" onClick={() => setArgs(current => [...current, { id: nextKvId(), value: "" }])}><Plus aria-hidden="true" />Add argument</Button></div></Field>
            <Field label="Working directory" htmlFor={`${id}-cwd`} hint="Optional. Relative paths start at the workspace folder."><Input id={`${id}-cwd`} value={draft.cwd} onChange={event => set("cwd", event.target.value)} placeholder="Workspace folder" className="text-fg1 font-sans" spellCheck={false} /></Field>
            <Field label="Also listens on" htmlFor={`${id}-listen`} hint="Optional. Connect to this local HTTP endpoint after launching the command."><Input id={`${id}-listen`} value={draft.listenUrl ?? ""} onChange={event => set("listenUrl", event.target.value)} placeholder="http://127.0.0.1:8080/mcp" className="text-fg1 font-sans" spellCheck={false} /></Field>
            <p className="text-fg3 m-0 text-xs">The command and working directory are checked on the machine where the agent runs.</p>
          </> : <>
            <Field label="URL" htmlFor={`${id}-url`}><Input id={`${id}-url`} value={draft.url} onChange={event => set("url", event.target.value)} placeholder="https://mcp.example.com/mcp" className="text-fg1 font-sans" spellCheck={false} autoComplete="off" /></Field>
            <ConnectionStatus state={connection?.key === probeKey ? connection : {}} />
            {probe && draft.url && !mcpUrlError(draft.url) && <div className="flex justify-end"><Button variant="ghost" size="compact" disabled={connection?.key === probeKey && connection.checking} onClick={() => setProbeAttempt(value => value + 1)}>Check connection</Button></div>}
          </>}
        </div>
      </div></Section>
      <Section title="Variables" description={draft.transport === "stdio" ? "Passed to the server as environment variables. Values are stored securely." : "Stored securely. Reference a value in a header with ${NAME}."}>
        <div className={CARD}><KeyValueFields kind="variable" rows={draft.env} onChange={rows => set("env", rows)} /></div>
      </Section>
      {draft.transport !== "stdio" && <>
        <Section title="Authentication"><RadioGroup aria-label="Authentication" value={draft.auth} onValueChange={value => { set("auth", value as Draft["auth"]); set("headers", []); }}>
          <RadioGroupItem variant="card" value="oauth" label="Sign in" description="Sign in through the service’s own login before your agents use it." />
          <RadioGroupItem variant="card" value="header" label="API key" description="Send a stored API key or token in request headers." />
          <RadioGroupItem variant="card" value="none" label="No sign-in" description="The server accepts requests without credentials." />
        </RadioGroup></Section>
        {draft.auth === "oauth" && <Section title="OAuth client">
          {!clientExpanded ? <div className={CARD}><SelectRow label={selectedClient.label} hint={selectedClient.description}><Button variant="ghost" onClick={() => setClientExpanded(true)}>Change</Button></SelectRow></div>
            : <RadioGroup aria-label="OAuth client" value={draft.oauthMode ?? "auto"} onValueChange={value => set("oauthMode", value as OAuthClientMode)}>
              {OAUTH_CLIENTS.map(client => <RadioGroupItem key={client.value} variant="card" value={client.value} label={client.label} description={client.description} />)}
            </RadioGroup>}
          {draft.oauthMode === "custom" && <div className={CARD}>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Client ID" htmlFor={`${id}-client`}><Input id={`${id}-client`} value={draft.oauthClientId} onChange={event => set("oauthClientId", event.target.value)} placeholder="Registered client ID" className="text-fg1 font-sans" spellCheck={false} /></Field>
              <Field label="Client secret" htmlFor={`${id}-secret`}><Input id={`${id}-secret`} type="password" autoComplete="new-password" value={draft.oauthClientSecret} onChange={event => { set("oauthClientSecret", event.target.value); set("clearOAuthClientSecret", false); }} placeholder={initial ? "Leave blank to keep saved value" : "Optional"} className="text-fg1 font-sans" /></Field>
            </div>
            {initial && <div className="flex justify-end"><Button variant="ghost" size="compact" onClick={() => { set("clearOAuthClientSecret", !draft.clearOAuthClientSecret); set("oauthClientSecret", ""); }}>{draft.clearOAuthClientSecret ? "Keep saved client secret" : "Remove saved client secret"}</Button></div>}
          </div>}
          <div className={CARD}><Field label="Scopes" htmlFor={`${id}-scopes`} hint="Optional permissions, separated by spaces."><Input id={`${id}-scopes`} value={draft.oauthScopes} onChange={event => set("oauthScopes", event.target.value)} placeholder="Service defaults" className="text-fg1 font-sans" spellCheck={false} /></Field></div>
        </Section>}
        {(draft.auth === "header" || (draft.auth === "oauth" && draft.headers.length > 0)) && <Section title="Headers" description="Header values are stored securely and sent with each request."><div className={CARD}>
          <KeyValueFields kind="header" rows={draft.headers} onChange={rows => set("headers", rows)} />
        </div></Section>}
      </>}
      <Collapsible open={importOpen} onOpenChange={setImportOpen}>
        <CollapsibleTrigger asChild><Button variant="ghost" className="text-fg2 px-0"><span>Import a configuration</span>{importOpen ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}</Button></CollapsibleTrigger>
        <CollapsibleContent className="pt-3"><div className={CARD}>
          <Field label="Configuration" htmlFor={`${id}-import`} hint="Paste MCP JSON, Codex TOML, a URL, or a command. You can also drop a configuration file.">
            <Textarea id={`${id}-import`} rows={6} value={importText} onChange={event => { importGeneration.current++; setImportText(event.target.value); }}
              placeholder={'{ "mcpServers": { … } } or npx -y my-mcp-server'} className="text-fg1 font-sans" spellCheck={false}
              onDragOver={event => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
              onDrop={event => { if (!event.dataTransfer.files.length) return; event.preventDefault(); void readFile(event.dataTransfer.files[0]); }} />
          </Field>
          {candidates.length > 1 && <Select value={candidateIndex} onValueChange={value => { setCandidateIndex(value); fill(candidates[Number(value)]); }}>
            <SelectTrigger aria-label="Server to import"><SelectValue /></SelectTrigger><SelectContent>{candidates.map((server, index) => <SelectItem value={String(index)} key={index}>{String(server.name)}</SelectItem>)}</SelectContent>
          </Select>}
          <div className="flex items-center justify-between gap-3"><Input ref={fileInput} type="file" className="sr-only" tabIndex={-1} accept=".json,.toml,.txt" aria-label="Configuration file" onChange={event => { const file = event.target.files?.[0]; if (file) void readFile(file); event.target.value = ""; }} />
            <Button variant="ghost" onClick={() => fileInput.current?.click()}><FileUp aria-hidden="true" />Choose file</Button>
            <Button variant="secondary" disabled={!importText.trim()} onClick={parse}>Parse</Button></div>
        </div></CollapsibleContent>
      </Collapsible>
    </fieldset>
  </div>;
}
