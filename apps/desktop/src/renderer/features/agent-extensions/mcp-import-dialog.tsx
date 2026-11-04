// ──────────────────────────────────────────────────────────
// Customize → MCP — "Import from other tools" (the adopt wizard)
// ──────────────────────────────────────────────────────────
//
// Detect-then-offer (never silent): scans the user's home MCP configs (Cursor /
// Claude / Codex / Factory) via the engine, lists what each declares grouped by
// source, and imports the selected servers into the Zeros user-level config.
// Servers already in Zeros are shown but not selectable (dedup by name). On
// import, a secret-shaped env value is moved into the Keychain (sentinel in
// settings) so tokens don't land in the file in plain text.
// ──────────────────────────────────────────────────────────

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../shared/ui";
import { Badge } from "../../shared/ui/primitives/badge";
import { Checkbox } from "../../shared/ui/primitives/checkbox";
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
  bridgeMcpGatewaySetHeaderSecret,
  bridgeMcpResolveComposed,
  bridgeMcpScanNative,
  type DiscoveredMcpServerWire,
  type DiscoveredMcpSourceWire,
} from "../../platform/bridge/workspace-bridge";
import { useSettingsLayer } from "../settings/use-settings";
import { MCP_SECRET_SENTINEL, looksSecretEnvName, setMcpSecret } from "../agent/mcp-secrets";
import {
  asString,
  endpointSummary,
  readRawServers,
  type RawServer,
} from "./mcp-server-model";

const keyOf = (source: string, name: string) => `${source}::${name}`;

/** Does an HTTP header VALUE look like a credential, regardless of its name? A
 *  header named e.g. `X-Custom` can still carry a bearer token; matching by name
 *  alone (looksSecretEnvName) would copy it into settings.toml in plain text. */
function looksSecretHeaderValue(v: string): boolean {
  const s = v.trim();
  if (!s) return false;
  if (/^bearer\s+\S/i.test(s)) return true; // "Bearer <token>"
  if (/^(sk|pk|rk|ghp|gho|ghs|github_pat|xox[baprs]|AKIA)[-_]/i.test(s)) return true; // common token prefixes
  // A long, single-token opaque value with no spaces = very likely a secret.
  if (s.length >= 20 && !/\s/.test(s) && /^[A-Za-z0-9._~+/=:-]+$/.test(s)) return true;
  return false;
}

/** A header is treated as secret if its NAME or its VALUE looks secret.
 *  Exported for the form's paste-JSON import, which must apply the same
 *  never-write-a-secret-to-TOML rule this wizard does. */
export function isSecretHeader(name: string, value: string): boolean {
  return !!value && (looksSecretEnvName(name) || looksSecretHeaderValue(value));
}

interface ImportResult {
  entry: RawServer;
  /** A secret-shaped header to store in the engine gateway vault (auth:"header"),
   *  set by the caller over the local bridge AFTER the settings write. */
  headerSecret?: { url: string; headerName: string; value: string };
  /** Secret-shaped headers we could NOT import (the gateway brokers only one
   *  static header) — surfaced to the user so a dropped credential isn't silent. */
  droppedSecretHeaders?: string[];
}

/** Map a discovered server to a settings entry. A secret-shaped stdio env value
 *  moves to the Keychain (sentinel in settings); a secret-shaped HTTP header is
 *  brokered through the gateway (auth:"header" — its value goes to the engine
 *  vault, NEVER settings). Non-secret env/headers are copied as-is. */
async function importToSettings(srv: DiscoveredMcpServerWire): Promise<ImportResult> {
  if (srv.transport === "stdio") {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(srv.env ?? {})) {
      if (v && looksSecretEnvName(k)) {
        await setMcpSecret(k, v);
        env[k] = MCP_SECRET_SENTINEL;
      } else {
        env[k] = v;
      }
    }
    return {
      entry: {
        name: srv.name,
        transport: "stdio",
        command: srv.command,
        ...(srv.cwd ? { cwd: srv.cwd } : {}),
        ...(srv.args && srv.args.length ? { args: srv.args } : {}),
        ...(Object.keys(env).length ? { env } : {}),
      },
    };
  }
  // http — broker the FIRST secret header (by name OR value shape) through the
  // gateway; keep non-secret headers plain. A SECOND secret header can't be
  // brokered (the gateway holds one static header), so it's dropped + reported
  // rather than written to settings.toml in plain text.
  const plain: Record<string, string> = {};
  let headerSecret: ImportResult["headerSecret"];
  const droppedSecretHeaders: string[] = [];
  for (const [k, v] of Object.entries(srv.headers ?? {})) {
    if (isSecretHeader(k, v)) {
      if (!headerSecret) headerSecret = { url: srv.url, headerName: k, value: v };
      else droppedSecretHeaders.push(k);
    } else {
      plain[k] = v;
    }
  }
  if (srv.oauth) {
    return {
      entry: { name: srv.name, transport: srv.transport, url: srv.url, auth: "oauth",
        ...(srv.oauth.clientId ? { oauth_client_id: srv.oauth.clientId } : {}),
        ...(srv.oauth.scopes?.length ? { oauth_scopes: srv.oauth.scopes } : {}),
      },
      ...(headerSecret || droppedSecretHeaders.length ? { droppedSecretHeaders: [...(headerSecret ? [headerSecret.headerName] : []), ...droppedSecretHeaders] } : {}),
    };
  }
  const entry: RawServer = headerSecret
    ? {
        name: srv.name,
        transport: srv.transport,
        url: srv.url,
        auth: "header",
        header_name: headerSecret.headerName,
        ...(Object.keys(plain).length ? { headers: plain } : {}),
      }
    : {
        name: srv.name,
        transport: srv.transport,
        url: srv.url,
        ...(Object.keys(plain).length ? { headers: plain } : {}),
      };
  return {
    entry,
    ...(headerSecret ? { headerSecret } : {}),
    ...(droppedSecretHeaders.length ? { droppedSecretHeaders } : {}),
  };
}

export function McpImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const bridge = useBridge();
  const { projects } = useProjects();
  const {
    layer, loading: settingsLoading, error: settingsError,
    readError: settingsReadError, refresh: refreshSettings, write,
  } = useSettingsLayer("user");
  const existing = useMemo(() => readRawServers(layer?.doc), [layer?.doc]);
  // Names already configured in Zeros (user + managed — the only MCP layers),
  // so an already-configured server shows as "Already added" instead of
  // re-importing a redundant dupe.
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
  const retry = useCallback(() => new Promise<void>(resolve => {
    retryWaiters.current.push(resolve);
    setLoading(true);
    setScanAttempt(value => value + 1);
  }), []);

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
    // Names already in Zeros (user + managed), so an already-configured server
    // shows as "Already added".
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

  const handleImport = async () => {
    if (!sources || !connected || scanError || loading || busy ||
        !layer || settingsLoading || settingsReadError || layer.error) return;
    setBusy(true);
    try {
      // Collect the selected servers, dedup by name (vs existing + each other).
      const seen = new Set<string>([...existingNames] as string[]);
      const picked: DiscoveredMcpServerWire[] = [];
      for (const src of sources) {
        for (const srv of src.servers) {
          if (!selected.has(keyOf(src.source, srv.name))) continue;
          if (seen.has(srv.name)) continue;
          seen.add(srv.name);
          picked.push(srv);
        }
      }
      if (picked.length === 0) {
        onClose();
        return;
      }
      const results: ImportResult[] = [];
      for (const srv of picked) results.push(await importToSettings(srv));
      await write({ mcp: { servers: [...existing, ...results.map((r) => r.entry)] } });
      // Store any brokered header secrets in the engine vault over the LOCAL
      // bridge AFTER the settings write, so the gateway reload connects the
      // backend with the key present (and the key never lands in settings).
      if (bridge) {
        for (const r of results) {
          if (!r.headerSecret) continue;
          try {
            await bridgeMcpGatewaySetHeaderSecret(
              bridge,
              r.headerSecret.url,
              r.headerSecret.headerName,
              r.headerSecret.value,
            );
          } catch {
            toast.error("Couldn't store an imported API key in the secret vault");
          }
        }
      }
      const dropped = results.flatMap((r) => r.droppedSecretHeaders ?? []);
      if (dropped.length) {
        toast.warning(
          `The Zeros gateway brokers one secret header per server, so these extra secret-shaped header(s) were not imported and must be set manually: ${dropped.join(", ")}`,
        );
      }
      toast.success(`Imported ${picked.length} MCP server${picked.length === 1 ? "" : "s"}`);
      onClose();
    } catch {
      toast.error("Couldn't import MCP servers");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Import MCP servers</DialogTitle>
          <DialogDescription>
            Copy MCP servers from your other tools. Secrets move to your Keychain.
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
                        // The server list's anatomy behind a checkbox: transport,
                        // name, endpoint; Already added is a badge.
                        return (
                          <Checkbox
                            key={key}
                            checked={isSel && !already}
                            onChange={() => toggle(key)}
                            disabled={already || busy}
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
                                {already && <Badge variant="neutral">Already added</Badge>}
                              </span>
                            }
                          />
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
            disabled={loading || !connected || !!scanError || !layer || settingsLoading || !!settingsReadError || !!layer.error || selectedCount === 0}
            onClick={() => void handleImport()}
          >
            {selectedCount > 0 ? `Import ${selectedCount}` : "Import"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
