import { mcpConnectionCache, mcpConnectionKey, rememberMcpConnection } from "./mcp-connection-status";
import { useCachedRead } from "../../state/use-cached-read";
import { mcpGatewayStatusCache, mcpGatewayStatusKey } from "../../state/read-caches";
import { toast } from "../../shared/ui/primitives/elements";
import { runtimeExecutionKey } from "../../platform/bridge/ws-client";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useBridge } from "../../platform/bridge/use-bridge";
import { workspaceOp, bridgeMcpValidateWorkingDirectory, bridgeMcpGatewayStatus, bridgeMcpGatewayAuthorize, bridgeMcpGatewayCancelAuth, bridgeMcpGatewayBeginAuth, bridgeMcpGatewayCompleteAuth, type SettingsReadWire } from "../../platform/bridge/workspace-bridge";
import { shellOpenUrl } from "../../platform/app";
import { useSettingsLayer, primeSettingsLayer } from "../settings/use-settings";
import { useProjects } from "../../state/use-projects";
import { getMcpSecret } from "../agent/mcp-secrets";
import { McpServerEditor, type McpProbeResult } from "./mcp-server-editor";
import { saveMcpDraft, secretChangesFromDraft } from "./mcp-form-save";
import { readRawServers, serverFromDraft, MCP_SECRET_SENTINEL, type Draft, type RawServer } from "./mcp-server-model";
import type { ResolvedCustomizeScope } from "./customize-page";
import { shouldUseHeadlessMcpAuth } from "./mcp-auth-flow";
import { HeadlessAuthModal } from "./customize-mcp";

/** Wait for the exact source snapshot before seeding an edit. Subsequent
 * refreshes update conflict checks, never replace the user's draft. */
export function McpServerFormPage({ scope, server, onBack, onSaved, surfaceActive = true, connectOnOpen = false }: {
  scope: ResolvedCustomizeScope; server: RawServer | null; onBack: () => void; onSaved?: (repoRoot?: string) => void; surfaceActive?: boolean; connectOnOpen?: boolean;
}) {
  const root = scope.kind === "repo" ? scope.project.repoRoot : undefined;
  return <LocalMcpEditor initial={server} initialProject={root ?? "all"} onBack={onBack} onSaved={onSaved} surfaceActive={surfaceActive} connectOnOpen={connectOnOpen} />;
}

function LocalMcpEditor({ initial: source, initialProject, onBack, onSaved, surfaceActive, connectOnOpen }: {
  initial: RawServer | null; initialProject: string; onBack: () => void; onSaved?: (repoRoot?: string) => void; surfaceActive: boolean; connectOnOpen: boolean;
}) {
  const [initial, setInitial] = useState(source);
  const [id] = useState(() => typeof initial?.credential_id === "string" ? initial.credential_id : crypto.randomUUID());
  const [project, setProject] = useState(initialProject);
  const repoRoot = project === "all" ? undefined : project;
  const layerName = repoRoot ? "repo-local" : "user";
  const { layer, loading, error } = useSettingsLayer(layerName, repoRoot);
  const { projects } = useProjects();
  const bridge = useBridge();
  const execution = useSyncExternalStore(
    useCallback(changed => bridge?.onExecutionIdentityChange(changed) ?? (() => {}), [bridge]),
    useCallback(() => bridge ? runtimeExecutionKey(bridge.executionIdentity) : "", [bridge]),
  );
  const servers = useMemo(() => readRawServers(layer?.doc), [layer?.doc]);
  const statusKey = bridge ? mcpGatewayStatusKey(bridge, execution, repoRoot) : null;
  const currentOwner = useRef(statusKey);
  currentOwner.current = statusKey;
  const status = useCachedRead(mcpGatewayStatusCache, statusKey, async key => {
    if (!bridge || key !== mcpGatewayStatusKey(bridge, runtimeExecutionKey(bridge.executionIdentity), repoRoot)) throw new Error("MCP connection changed.");
    const result = await bridgeMcpGatewayStatus(bridge, repoRoot);
    if (key !== mcpGatewayStatusKey(bridge, runtimeExecutionKey(bridge.executionIdentity), repoRoot)) throw new Error("MCP connection changed.");
    return result;
  }, { enabled: surfaceActive && Boolean(initial), maxAgeMs: 30_000 });
  const verificationKey = initial && statusKey ? mcpConnectionKey(statusKey, initial) : "new-local-mcp";
  const verification = useSyncExternalStore(useCallback(listener => mcpConnectionCache.subscribe(verificationKey, listener), [verificationKey]), useCallback(() => mcpConnectionCache.getSnapshot(verificationKey), [verificationKey]));
  const onVerified = useCallback((draft: Draft, result: McpProbeResult) => {
    if (initial && statusKey && mcpConnectionKey(statusKey, serverFromDraft(draft, initial)) === verificationKey) rememberMcpConnection(statusKey, initial, result);
  }, [initial, statusKey, verificationKey]);
  const [connecting, setConnecting] = useState(false);
  const [headlessAuth, setHeadlessAuth] = useState<{ server: string; url: string } | null>(null);
  const [headlessBusy, setHeadlessBusy] = useState(false);
  const authGeneration = useRef(0);
  const pendingAuth = useRef<RawServer | null>(null);
  const cancelAuth = useCallback(() => {
    authGeneration.current++;
    if (pendingAuth.current && bridge && runtimeExecutionKey(bridge.executionIdentity) === execution)
      void bridgeMcpGatewayCancelAuth(bridge, String(pendingAuth.current.name), repoRoot).catch(() => {});
    pendingAuth.current = null;
  }, [bridge, execution, repoRoot]);
  useEffect(() => {
    setConnecting(false); setHeadlessAuth(null); setHeadlessBusy(false);
    return cancelAuth;
  }, [surfaceActive, cancelAuth]);
  const connected = (server: RawServer, toolCount: number, tools?: string[]) => {
    if (statusKey) {
      rememberMcpConnection(statusKey, server, { status: "connected", stages: [], toolCount, ...(tools ? { tools } : {}) });
      // A read begun before sign-in must not replace the authorization result.
      mcpGatewayStatusCache.invalidate(statusKey);
    }
    status.refresh(); toast.success("MCP server connected");
  };
  const connect = async (server: RawServer) => {
    if (!bridge || !surfaceActive || pendingAuth.current) return;
    pendingAuth.current = server; setConnecting(true);
    const generation = ++authGeneration.current;
    const current = () => generation === authGeneration.current && statusKey === currentOwner.current && runtimeExecutionKey(bridge.executionIdentity) === execution;
    let awaitingCode = false;
    try {
      const result = await bridgeMcpGatewayAuthorize(bridge, String(server.name), repoRoot);
      if (!current()) return;
      if (result.state !== "connected") throw new Error("Sign-in completed, but the server could not connect. Check the URL and try again.");
      connected(server, result.toolCount, result.tools);
    } catch (error) {
      if (!current()) return;
      if (shouldUseHeadlessMcpAuth(error)) {
        const url = await bridgeMcpGatewayBeginAuth(bridge, String(server.name), repoRoot);
        if (!current()) return;
        awaitingCode = true; setHeadlessAuth({ server: String(server.name), url });
        try { await shellOpenUrl(url); }
        catch { if (current()) toast.error("Could not open the browser. Open the sign-in URL to continue."); }
      } else throw error;
    } finally { if (current() && !awaitingCode) { pendingAuth.current = null; setConnecting(false); } }
  };
  const completeHeadless = async (code: string) => {
    const server = pendingAuth.current;
    if (!bridge || !server || headlessBusy) return;
    const generation = authGeneration.current;
    setHeadlessBusy(true);
    try {
      const result = await bridgeMcpGatewayCompleteAuth(bridge, String(server.name), code, repoRoot);
      if (generation !== authGeneration.current || statusKey !== currentOwner.current) return;
      if (result.state !== "connected") throw new Error("Sign-in completed, but the server could not connect. Try again.");
      connected(server, result.toolCount, result.tools);
    } catch (error) { if (generation === authGeneration.current) toast.error(error instanceof Error ? error.message : "Could not finish sign-in."); }
    finally { if (generation === authGeneration.current) { pendingAuth.current = null; setConnecting(false); setHeadlessBusy(false); setHeadlessAuth(null); } }
  };
  const onSave = useCallback(async (draft: Draft, verification?: McpProbeResult) => {
    if (!bridge || !layer || loading || error) throw new Error("The selected project is unavailable. Reconnect and try again.");
    if (repoRoot && !projects.some(row => row.repoRoot === repoRoot)) throw new Error("This project was removed. Choose another project.");
    const takenNames = new Set(servers.filter(row => !(initial && (initial.credential_id ? row.credential_id === initial.credential_id : row.name === initial.name))).map(row => String(row.name)));
    let saved!: RawServer;
    const assertOwner = () => {
      if (statusKey !== currentOwner.current || runtimeExecutionKey(bridge.executionIdentity) !== execution) throw new Error("The connection changed. Reopen this server before saving.");
    };
    await saveMcpDraft({ draft, initial, takenNames, persist: async (server, secrets) => {
      if (draft.transport === "stdio" && draft.cwd.trim()) await bridgeMcpValidateWorkingDirectory(bridge, draft.cwd.trim(), repoRoot);
      // Upgrade only this existing entry's legacy Keychain references. New
      // configurations use one native encrypted vault transaction for all values.
      if (draft.transport === "stdio" && initial && !initial.credential_id) {
        for (const [name, value] of Object.entries((server.env ?? {}) as Record<string, string>)) {
          if (value !== MCP_SECRET_SENTINEL || secrets.env?.[name] !== undefined) continue;
          const stored = await getMcpSecret(name, repoRoot ? { kind: "repo", repoRoot } : { kind: "user" });
          if (stored === null) throw new Error(`Enter a value for ${name} before saving.`);
          secrets.env = { ...secrets.env, [name]: stored };
        }
      }
      assertOwner();
      const result = await workspaceOp(bridge, "mcp.saveServer", {
        layer: layerName, ...(repoRoot ? { repoRoot } : {}), previous: initial,
        server: { ...server, credential_id: id }, secrets,
      }) as Pick<SettingsReadWire, "path" | "doc">;
      assertOwner();
      primeSettingsLayer(layerName, repoRoot, result);
      saved = readRawServers(result.doc).find(row => row.credential_id === id) ?? { ...server, credential_id: id };
      if (statusKey) rememberMcpConnection(statusKey, saved, verification);
    } });
    setInitial(saved);
    return saved;
  }, [bridge, execution, layer, loading, error, repoRoot, projects, servers, initial, layerName, id, statusKey]);
  const probe = useCallback(async (draft: Draft, signal: AbortSignal): Promise<McpProbeResult> => {
    if (!bridge) throw new Error("Connect to the local engine to check this server.");
    const requestId = crypto.randomUUID();
    const cancel = () => { void workspaceOp(bridge, "mcp.cancelProbe", { requestId }).catch(() => {}); };
    signal.throwIfAborted(); signal.addEventListener("abort", cancel, { once: true });
    try {
      return await workspaceOp(bridge, "mcp.probe", {
        requestId, ...(repoRoot ? { repoRoot } : {}),
        server: { ...serverFromDraft({ ...draft, name: draft.name.trim() || "connection-check" }, initial), credential_id: id },
        secrets: secretChangesFromDraft(draft),
      }, 16_000) as McpProbeResult;
    } finally { signal.removeEventListener("abort", cancel); }
  }, [bridge, repoRoot, initial, id]);
  const gateway = initial ? status.data?.servers.find(row => row.name === initial.name && row.url === initial.url) : undefined;
  const checked = !gateway || verification.updatedAt >= status.updatedAt ? verification.data : undefined;
  return <><McpServerEditor initial={initial} target={{ identity: statusKey ?? "unavailable-local", organization: false, owner: "user", project,
    projects: projects.map(row => ({ value: row.repoRoot, label: row.name })),
    ...(!initial ? { onProjectChange: setProject } : {}), loading: !layer || loading,
  }} onSave={onSave} onBack={onBack} onSaved={onSaved ? () => onSaved(repoRoot) : onBack} probe={probe} onVerified={onVerified} surfaceActive={surfaceActive} connectOnOpen={connectOnOpen}
    savedConnection={{
      status: checked ? checked.status === "failed" ? "error" : checked.status : gateway?.state ?? "needs-connection",
      tools: verification.data?.tools ?? gateway?.tools, verification: checked,
      connecting, onConnect: connect, onCancel: () => { cancelAuth(); setConnecting(false); setHeadlessAuth(null); setHeadlessBusy(false); },
    }} />
    <HeadlessAuthModal state={headlessAuth} busy={headlessBusy} onComplete={code => void completeHeadless(code)}
      onCancel={() => { cancelAuth(); setConnecting(false); setHeadlessAuth(null); setHeadlessBusy(false); }} />
  </>;
}
