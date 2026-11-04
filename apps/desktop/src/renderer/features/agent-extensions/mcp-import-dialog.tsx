import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../shared/ui";
import { Badge } from "../../shared/ui/primitives/badge";
import { Checkbox } from "../../shared/ui/primitives/checkbox";
import { Field } from "../../shared/ui/primitives/field";
import { Input } from "../../shared/ui/primitives/input";
import { MessageRow } from "../../shared/ui/primitives/message-row";
import {
  Dialog,
  DialogContent,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../shared/ui/primitives/dialog";
import { toast } from "../../shared/ui/primitives/elements";
import { useBridge, useBridgeStatus } from "../../platform/bridge/use-bridge";
import { useReadRecovery } from "../../state/use-read-recovery";
import { useDocumentActive } from "../../state/use-document-active";
import { useProjects } from "../../state/use-projects";
import {
  bridgeMcpResolveComposed,
  bridgeMcpScanNative,
  bridgeSettingsRead,
  workspaceOp,
  type DiscoveredMcpServerWire,
  type DiscoveredMcpSourceWire,
  type SettingsReadWire,
} from "../../platform/bridge/workspace-bridge";
import { runtimeExecutionKey } from "../../platform/bridge/ws-client";
import { primeSettingsLayer, useSettingsLayer } from "../settings/use-settings";
import { mcpDraftError, secretChangesFromDraft, type McpSecretChanges } from "./mcp-form-save";
import {
  asString,
  endpointSummary,
  readRawServers,
  secureDraftFromServer,
  serverFromDraft,
  type RawServer,
} from "./mcp-server-model";

const keyOf = (source: string, name: string) => `${source}::${name}`;

interface ImportResult {
  entry: RawServer;
  secrets: McpSecretChanges;
}

function importToSettings(srv: DiscoveredMcpServerWire, credentialId: string = crypto.randomUUID()): ImportResult {
  const oauth = srv.transport !== "stdio" ? srv.oauth : undefined;
  const draft = secureDraftFromServer({
    ...srv,
    ...(oauth ? {
      auth: "oauth",
      ...(oauth.clientId ? { oauth_client_id: oauth.clientId } : {}),
      ...(oauth.scopes?.length ? { oauth_scopes: oauth.scopes } : {}),
    } : {}),
  });
  const error = mcpDraftError(draft);
  if (error) throw new Error(error);
  return {
    entry: { ...serverFromDraft(draft, null), credential_id: credentialId },
    secrets: secretChangesFromDraft(draft),
  };
}

function selectedImports(sources: DiscoveredMcpSourceWire[], selected: Set<string>, names: Record<string, string>) {
  return sources.flatMap(src => src.servers.flatMap(srv => {
    const key = keyOf(src.source, srv.name);
    return selected.has(key) ? [{ key, server: { ...srv, name: (names[key] ?? srv.name).trim() } }] : [];
  }));
}

function importNameErrors(picked: ReturnType<typeof selectedImports>, taken: Set<string>, existing: RawServer[], credentialIds: Map<string, string>): Map<string, string> {
  const counts = new Map<string, number>();
  for (const { server } of picked) counts.set(server.name, (counts.get(server.name) ?? 0) + 1);
  const errors = new Map<string, string>();
  for (const { key, server } of picked) {
    if (!server.name) errors.set(key, "Enter an import name.");
    else if ((counts.get(server.name) ?? 0) > 1 ||
      (taken.has(server.name) && !existing.some(row => row.name === server.name && row.credential_id === credentialIds.get(key) && row.credential_id))) {
      errors.set(key, "This name is already used. Choose a different import name.");
    }
  }
  return errors;
}

function sameImportEntry(saved: RawServer, entry: RawServer): boolean {
  const signature = (server: RawServer) => JSON.stringify(server, (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value);
  return signature(saved) === signature(entry);
}

export function McpImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const bridge = useBridge();
  const { projects } = useProjects();
  const {
    layer, loading: settingsLoading, error: settingsError,
    readError: settingsReadError, refresh: refreshSettings,
  } = useSettingsLayer("user");
  const existing = useMemo(() => readRawServers(layer?.doc), [layer?.doc]);
  const [composedNames, setComposedNames] = useState<Set<string>>(new Set());
  const existingNames = useMemo(() => {
    const s = new Set(existing.map((x) => asString(x.name)).filter(Boolean) as string[]);
    for (const n of composedNames) s.add(n);
    return s;
  }, [existing, composedNames]);

  const [sources, setSources] = useState<DiscoveredMcpSourceWire[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanAttempt, setScanAttempt] = useState(0);
  const retryWaiters = useRef<Array<() => void>>([]);
  const bridgeStatus = useBridgeStatus();
  const connected = !!bridge && bridgeStatus === "connected";
  const active = useDocumentActive(open);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [names, setNames] = useState<Record<string, string>>({});
  const [imported, setImported] = useState<Set<string>>(new Set());
  const credentialIds = useRef(new Map<string, string>());
  const importGeneration = useRef(0);
  const importPending = useRef(false);
  const retry = useCallback(() => new Promise<void>(resolve => {
    retryWaiters.current.push(resolve);
    setLoading(true);
    setScanAttempt(value => value + 1);
  }), []);
  useLayoutEffect(() => {
    const generation = importGeneration.current;
    if (!open) {
      setNames({});
      setImported(new Set());
      credentialIds.current.clear();
    }
    return () => { importGeneration.current = generation + 1; };
  }, [open, active, bridge, connected]);

  // Scan each time the dialog opens.
  useEffect(() => {
    if (!open) {
      setSources(null);
      setScanError(null);
      return;
    }
    if (!active) return;
    if (!bridge || !connected) {
      setLoading(true);
      setScanError(null);
      return;
    }
    let live = true;
    setLoading(true);
    setScanError(null);
    void bridgeMcpResolveComposed(bridge)
      .catch(() => [])
      .then((list) => {
        if (!live) return;
        setComposedNames(new Set(list.map((s) => s.name)));
      });
    void bridgeMcpScanNative(
      bridge,
      projects.map((p) => p.repoRoot),
    )
      .then((found) => {
        if (!live) return;
        setSources(found);
        // Pre-select on open. Rescans keep the user's choices only while the
        // servers remain available, without selecting newly discovered rows.
        const sel = new Set<string>();
        for (const src of found) {
          for (const srv of src.servers) {
            if (!existingNames.has(srv.name)) sel.add(keyOf(src.source, srv.name));
          }
        }
        setSelected(current => sources === null
          ? sel
          : new Set([...current].filter(key => sel.has(key))));
      })
      .catch((e) => live && setScanError(e instanceof Error ? e.message : String(e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
    // existingNames intentionally omitted — re-scan only on open, not on every
    // settings refetch (which would clobber the user's checkbox selection).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active, bridge, connected, scanAttempt]);
  const readError = useMemo(() => scanError ? new Error(scanError) : null, [scanError]);
  const recovery = useReadRecovery("mcp-import-scan", {
    error: readError,
    pending: loading,
    hasContent: sources !== null,
    connected,
    active,
    retry,
  });
  // An effect trigger is not a completed retry. Settle only after the actual
  // scan's result has committed, or the dialog/connection retires it.
  useLayoutEffect(() => {
    if (!loading || !active || !connected)
      for (const resolve of retryWaiters.current.splice(0)) resolve();
  }, [loading, active, connected]);
  useEffect(() => () => {
    for (const resolve of retryWaiters.current.splice(0)) resolve();
  }, []);

  const toggle = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const selectedCount = selected.size;
  const found = sources?.flatMap((s) => s.servers) ?? [];
  const hasAny = found.length > 0;
  const importError = recovery.error?.message ?? settingsError ?? layer?.error;
  const nameErrors = importNameErrors(selectedImports(sources ?? [], selected, names), existingNames, existing, credentialIds.current);

  const handleImport = async () => {
    if (!sources || !connected || scanError || loading || busy ||
        !layer || settingsLoading || settingsReadError || layer.error || !bridge || importPending.current) return;
    importPending.current = true;
    setBusy(true);
    const generation = importGeneration.current;
    const execution = runtimeExecutionKey(bridge.executionIdentity);
    const current = () => generation === importGeneration.current && bridge.status === "connected" &&
      runtimeExecutionKey(bridge.executionIdentity) === execution;
    let completed = 0;
    try {
      const picked = selectedImports(sources, selected, names);
      if (!picked.length) return;
      const latest = await bridgeSettingsRead(bridge, "user");
      if (!current()) return;
      if (latest.error) throw new Error("MCP settings are unavailable.");
      primeSettingsLayer("user", undefined, latest);
      let savedServers = readRawServers(latest.doc);
      const taken = new Set([...existingNames, ...savedServers.map(row => String(row.name))]);
      if (importNameErrors(picked, taken, savedServers, credentialIds.current).size) {
        toast.error("Choose a different import name for each selected server.");
        return;
      }
      const results = picked.map(({ key, server }) => {
        const id = credentialIds.current.get(key) ?? crypto.randomUUID();
        credentialIds.current.set(key, id);
        return { key, ...importToSettings(server, id) };
      });
      for (const { key, entry, secrets } of results) {
        // Settings publish only after the vault acknowledgement. A confirmed
        // matching entry completes a lost reply without repeating the mutation.
        const previous = savedServers.find(row => row.credential_id === entry.credential_id) ?? null;
        if (previous) {
          if (!sameImportEntry(previous, entry)) throw new Error("An imported server changed. Review it before importing again.");
        } else {
          const saved = await workspaceOp(bridge, "mcp.saveServer", {
            layer: "user", previous: null, server: entry, secrets,
          }) as Pick<SettingsReadWire, "path" | "doc">;
          if (!current()) return;
          savedServers = readRawServers(saved.doc);
          primeSettingsLayer("user", undefined, saved);
        }
        completed++;
        setImported(prior => new Set([...prior, key]));
        setSelected(prior => { const next = new Set(prior); next.delete(key); return next; });
      }
      toast.success(`Imported ${completed} MCP server${completed === 1 ? "" : "s"}`);
      onClose();
    } catch {
      if (current()) {
        refreshSettings();
        toast.error(completed
          ? `Imported ${completed} MCP server${completed === 1 ? "" : "s"}. The remaining servers are still selected; retry to finish.`
          : "Couldn't import MCP servers. Your selections are kept; retry to finish.");
      }
    } finally {
      importPending.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Import MCP servers</DialogTitle>
          <DialogDescription>
            Copy MCP servers from your other tools. Environment values and
            headers are saved encrypted for each server.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="flex max-h-[50vh] flex-col gap-4 overflow-y-auto">
            {importError && (
              <MessageRow
                tone="error"
                role="alert"
                flush
                actions={
                  <Button variant="ghost" size="compact" onClick={() => void (recovery.error ? retry() : refreshSettings())}>
                    Retry
                  </Button>
                }
              >
                {importError}
              </MessageRow>
            )}
            {!sources && !importError ? (
              <MessageRow tone="pending" role="status" flush>
                Scanning…
              </MessageRow>
            ) : !sources ? null : !hasAny ? (
              <p className="text-fg2 m-0 py-6 text-center text-xs leading-4.5">
                No MCP servers found.
              </p>
            ) : (
              (sources ?? [])
                .filter((src) => src.servers.length > 0 || src.warning)
                .map((src) => (
                  <section key={src.source} className="flex flex-col gap-1">
                    <h3 className="text-fg3 m-0 text-3xxs leading-4 font-medium">{src.label}</h3>
                    {src.warning && (
                      <MessageRow tone="warning" flush>
                        {src.warning}
                      </MessageRow>
                    )}
                    <div className="flex flex-col">
                      {src.servers.map((srv) => {
                        const already = existingNames.has(srv.name);
                        const key = keyOf(src.source, srv.name);
                        const isSel = selected.has(key);
                        const done = imported.has(key);
                        const nameError = nameErrors.get(key);
                        // The server list's anatomy behind a checkbox: transport,
                        // name, endpoint; Imported and Name in use are badges.
                        return (
                          <div key={key} className="flex flex-col">
                            <Checkbox
                              checked={isSel || done}
                              onChange={() => toggle(key)}
                              disabled={done || busy}
                              className="w-full py-2 [&>span[aria-hidden]]:mt-0.5"
                              label={
                                <span className="flex min-w-0 items-center gap-3">
                                  <span className="flex w-12 shrink-0">
                                    <Badge variant="outline" mono>{srv.transport}</Badge>
                                  </span>
                                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                                    <span className="text-fg1 truncate text-xs leading-4.5">{srv.name}</span>
                                    <span className="text-fg3 truncate font-mono text-3xxs leading-4">
                                      {endpointSummary(srv as RawServer)}
                                    </span>
                                  </span>
                                  {done ? <Badge variant="success">Imported</Badge>
                                    : already && <Badge variant="neutral">Name in use</Badge>}
                                </span>
                              }
                            />
                            {isSel && (nameError || names[key] !== undefined) && (
                              <Field label="Import name" error={nameError} className="pb-2 pl-6">
                                <Input
                                  aria-label={`Import name for ${srv.name} from ${src.label}`}
                                  value={names[key] ?? srv.name}
                                  disabled={busy}
                                  onChange={event => setNames(prior => ({ ...prior, [key]: event.target.value }))}
                                />
                              </Field>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </section>
                ))
            )}

            {hasAny && (
              <p className="text-fg3 m-0 text-3xxs leading-4">
                Cursor allows about 40 tools in total.
              </p>
            )}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={loading || !connected || !!scanError || !layer || settingsLoading || !!settingsReadError || !!layer.error || selectedCount === 0 || nameErrors.size > 0}
            onClick={() => void handleImport()}
          >
            {selectedCount > 0 ? `Import ${selectedCount}` : "Import"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
