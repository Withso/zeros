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

import React, { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check } from "lucide-react";

import { Button } from "../../shared/ui";
import { Tooltip } from "@/renderer/shared/ui/primitives";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../shared/ui/primitives/dialog";
import { toast } from "../../shared/ui/primitives/elements";
import { cn } from "@/renderer/shared/ui/cn";
import { useBridge } from "../../platform/bridge/use-bridge";
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
import { ZerosSpinner } from "@/renderer/shared/ui/loading";

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
  const entry: RawServer = headerSecret
    ? {
        name: srv.name,
        transport: "http",
        url: srv.url,
        auth: "header",
        header_name: headerSecret.headerName,
        ...(Object.keys(plain).length ? { headers: plain } : {}),
      }
    : {
        name: srv.name,
        transport: "http",
        url: srv.url,
        ...(Object.keys(plain).length ? { headers: plain } : {}),
      };
  return {
    entry,
    ...(headerSecret ? { headerSecret } : {}),
    ...(droppedSecretHeaders.length ? { droppedSecretHeaders } : {}),
  };
}

function TransportPill({ transport }: { transport: "stdio" | "http" }) {
  return (
    <span className="select-none rounded-sm border border-border1 px-1.5 py-px text-xs font-medium text-fg2">
      {transport}
    </span>
  );
}

export function McpImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const bridge = useBridge();
  const { projects } = useProjects();
  const { layer, write } = useSettingsLayer("user");
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
  const [loading, setLoading] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  // Scan each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    if (!bridge) {
      setScanError("Not connected to the engine.");
      return;
    }
    let live = true;
    setLoading(true);
    setScanError(null);
    setSources(null);
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
        // Pre-select everything not already in Zeros.
        const sel = new Set<string>();
        for (const src of found) {
          for (const srv of src.servers) {
            if (!existingNames.has(srv.name)) sel.add(keyOf(src.source, srv.name));
          }
        }
        setSelected(sel);
      })
      .catch((e) => live && setScanError(e instanceof Error ? e.message : String(e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
    // existingNames intentionally omitted — re-scan only on open, not on every
    // settings refetch (which would clobber the user's checkbox selection).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, bridge]);

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

  const handleImport = async () => {
    if (!sources) return;
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
            Found in your other tools’ configs. Imported servers become available to
            Claude, Codex, and Cursor. Token-shaped env values move to your Keychain;
            secret HTTP headers move to the gateway’s encrypted vault.
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[50vh] flex-col gap-4 overflow-y-auto">
          {loading ? (
            <div className="flex items-center gap-2 py-8 text-sm text-fg2">
              <ZerosSpinner size={16} />
              Scanning…
            </div>
          ) : scanError ? (
            <p className="flex items-center gap-1.5 py-4 text-sm text-red-primary">
              <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
              {scanError}
            </p>
          ) : !hasAny ? (
            <p className="py-8 text-center text-sm text-fg2">
              No MCP servers found in Cursor, Claude, Codex, or Factory configs.
            </p>
          ) : (
            (sources ?? [])
              .filter((src) => src.servers.length > 0 || src.warning)
              .map((src) => (
                <section key={src.source} className="flex flex-col gap-1.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <h3 className="text-xs font-medium text-fg2">{src.label}</h3>
                    {src.warning && (
                      <Tooltip label={src.warning}>
                        <span className="truncate text-xs text-fg2">
                          {src.warning}
                        </span>
                      </Tooltip>
                    )}
                  </div>
                  <div className="flex flex-col">
                    {src.servers.map((srv) => {
                      const already = existingNames.has(srv.name);
                      const key = keyOf(src.source, srv.name);
                      const isSel = selected.has(key);
                      return (
                        <button
                          key={key}
                          type="button"
                          disabled={already || busy}
                          onClick={() => toggle(key)}
                          className={cn(
                            "flex items-center gap-2.5 rounded-sm px-1.5 py-2 text-left",
                            already ? "opacity-50" : "hover:bg-bg2",
                          )}
                        >
                          <span
                            className={cn(
                              "flex size-4 shrink-0 items-center justify-center rounded-sm border",
                              isSel && !already
                                ? "border-primary-button-bg bg-primary-button-bg text-primary-button-fg"
                                : "border-border2",
                            )}
                            aria-hidden="true"
                          >
                            {isSel && !already && <Check className="size-3" />}
                          </span>
                          <TransportPill transport={srv.transport} />
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm text-fg1">{srv.name}</div>
                            <div className="truncate font-mono text-xs text-fg2">
                              {endpointSummary(srv as RawServer)}
                            </div>
                          </div>
                          {already && (
                            <span className="shrink-0 text-xs text-fg2">Already added</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </section>
              ))
          )}

          {hasAny && (
            <p className="text-xs text-fg2">
              Tip: Cursor caps the total number of MCP tools at ~40 across all servers —
              importing many at once may exceed that.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="default"
            size="sm"
            disabled={busy || loading || selectedCount === 0}
            onClick={() => void handleImport()}
            className="gap-1.5"
          >
            {busy && <ZerosSpinner size={16} tone="inverted" />}
            {selectedCount > 0 ? `Import ${selectedCount}` : "Import"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
