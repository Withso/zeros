// ──────────────────────────────────────────────────────────
// Customize → MCP — the IN-PAGE add/edit server form
// ──────────────────────────────────────────────────────────
//
// A full page (breadcrumb back to the list), not a dialog — the founder's
// reference design. Scope-aware like the list: the user scope writes
// `~/.zeros/settings.toml`, a repo scope writes that repo's personal
// `.zeros/settings.local.toml`.
//
// Layout (dark reference, our design system):
//   MCP › Add custom MCP                                   (breadcrumb)
//   Create a custom MCP server                             (title)
//   [identity card: name + short description | Import JSON · Add]
//   Connection
//   [transport / command / arguments — or URL / auth]
//   [Environment variables]  (stdio — plain values, land in the TOML)
//   [Secrets]                (stdio — Keychain-backed, sentinel in the TOML)
//
// Secrets here are the same mechanism the old dialog's 🔒 rows used: the
// value goes to the OS Keychain (scope-aware account) and the settings file
// carries only the `${zeros.secret}` sentinel; the renderer couriers the real
// value into the agent's process env at spawn. Splitting them into their own
// card just makes the safe path the obvious one.
// ──────────────────────────────────────────────────────────

import React, { useMemo, useState } from "react";
import {
  AlertTriangle,
  ChevronRight,
  ClipboardPaste,
  Plus,
  Trash2,
} from "lucide-react";

import { Button, Input, Textarea } from "../ui";
import { Tooltip } from "@/zeros/ui/primitives";
import { cn } from "@/zeros/ui/cn";
import { toast } from "../ui/primitives/elements";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/primitives/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/primitives/select";
import { ZerosSpinner } from "@/loaders";
import { useBridge } from "../bridge/use-bridge";
import { bridgeMcpGatewaySetHeaderSecret } from "../bridge/workspace-bridge";
import { useSettingsLayer } from "../settings/use-settings";
import {
  MCP_SECRET_SENTINEL,
  looksSecretEnvName,
  setMcpSecret,
  type McpSecretScope,
} from "../agent/mcp-secrets";
import { isSecretHeader } from "./mcp-import-dialog";
import {
  asString,
  draftError,
  draftFromServer,
  newHeaderSecretFromDraft,
  newSecretsFromDraft,
  nextKvId,
  readRawServers,
  serverFromDraft,
  type Draft,
  type KV,
  type RawServer,
  type Transport,
} from "./mcp-panel-helpers";
import { parseMcpJsonImport } from "./customize-helpers";
import type { ResolvedCustomizeScope } from "./customize-page";

// The filled-card recipe shared with the list (models-page vocabulary).
const CARD_CLS = "bg-bg1-highlight rounded-lg";
const CARD_ROWS_CLS = cn(CARD_CLS, "divide-border1 flex flex-col divide-y px-4");

/** Label-left / control-right row inside a connection card — the models-page
 *  row shape, with the control given room (inputs want more than a Select). */
function FormRow({
  label,
  hint,
  htmlFor,
  align = "center",
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  align?: "center" | "start";
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex justify-between gap-6 py-3.5",
        align === "center" ? "items-center" : "items-start",
      )}
    >
      <div className="flex w-2/5 min-w-0 shrink-0 flex-col gap-0.5">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="text-fg1 text-[14px] font-medium">
            {label}
          </label>
        ) : (
          <span className="text-fg1 text-[14px] font-medium">{label}</span>
        )}
        {hint && <span className="text-fg2 text-xs leading-relaxed">{hint}</span>}
      </div>
      <div className="flex min-w-0 flex-1 justify-end">{children}</div>
    </div>
  );
}

/** The dashed list container the reference design uses for arguments /
 *  env vars / secrets — empty text when no rows, rows + trailing Add. */
function DashedListBox({
  empty,
  addLabel,
  onAdd,
  children,
  hasRows,
}: {
  empty: string;
  addLabel: string;
  onAdd: () => void;
  hasRows: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="border-border2 flex w-full flex-col items-stretch gap-2 rounded-md border border-dashed p-3">
      {hasRows ? (
        children
      ) : (
        <p className="text-fg2 py-4 text-center text-sm">{empty}</p>
      )}
      <div>
        <Button
          variant="secondary"
          size="sm"
          className="gap-1.5"
          onClick={onAdd}
        >
          <Plus className="size-3.5" aria-hidden="true" />
          {addLabel}
        </Button>
      </div>
    </div>
  );
}

/** One argument row: value + remove. */
function ArgRow({
  value,
  onChange,
  onRemove,
}: {
  value: string;
  onChange: (v: string) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="-y"
        className="font-mono text-sm"
        aria-label="Argument"
      />
      <Tooltip label="Remove">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onRemove}
          className="text-fg2 hover:bg-red-primary/10 hover:text-red-primary shrink-0"
          aria-label="Remove argument"
        >
          <Trash2 className="size-3.5" aria-hidden="true" />
        </Button>
      </Tooltip>
    </div>
  );
}

/** One key/value row (env vars, secrets, headers). */
function KvRow({
  row,
  keyPlaceholder,
  valuePlaceholder,
  password,
  onChange,
  onRemove,
}: {
  row: KV;
  keyPlaceholder: string;
  valuePlaceholder: string;
  /** Mask the value input (secrets). */
  password?: boolean;
  onChange: (patch: Partial<KV>) => void;
  onRemove: () => void;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] items-center gap-2">
      <Input
        value={row.key}
        onChange={(e) => onChange({ key: e.target.value })}
        placeholder={keyPlaceholder}
        className="font-mono text-sm"
        aria-label="Name"
      />
      <Input
        value={row.value}
        onChange={(e) => onChange({ value: e.target.value })}
        type={password ? "password" : "text"}
        placeholder={valuePlaceholder}
        className="font-mono text-sm"
        aria-label="Value"
        autoComplete="off"
      />
      <Tooltip label="Remove">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onRemove}
          className="text-fg2 hover:bg-red-primary/10 hover:text-red-primary"
          aria-label="Remove"
        >
          <Trash2 className="size-3.5" aria-hidden="true" />
        </Button>
      </Tooltip>
    </div>
  );
}

/** Card with its own header (title + hint left, action right) and a dashed
 *  list body — the Environment variables / Secrets shape in the reference. */
function ListCard({
  title,
  hint,
  action,
  children,
}: {
  title: string;
  hint: string;
  action: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className={cn(CARD_CLS, "flex flex-col gap-3 p-4")}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 className="text-fg1 m-0 text-[14px] font-medium">{title}</h3>
          <p className="text-fg2 m-0 text-xs leading-relaxed">{hint}</p>
        </div>
        <div className="shrink-0">{action}</div>
      </div>
      {children}
    </section>
  );
}

/** Paste-a-JSON import: fills the form from a single pasted config, or —
 *  when the paste declares several servers — offers to add them all. */
function ImportJsonDialog({
  open,
  onClose,
  onSingle,
  onMany,
}: {
  open: boolean;
  onClose: () => void;
  /** One server parsed → seed the form with it. */
  onSingle: (server: RawServer) => void;
  /** Several servers parsed → append them all to the list. */
  onMany: (servers: RawServer[]) => void;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const handleImport = () => {
    const parsed = parseMcpJsonImport(text);
    if (parsed.error) {
      setError(parsed.error);
      return;
    }
    for (const w of parsed.warnings) toast.warning(w);
    if (parsed.servers.length === 0) {
      setError("No usable servers in that JSON.");
      return;
    }
    if (parsed.servers.length === 1) onSingle(parsed.servers[0]);
    else onMany(parsed.servers);
    setText("");
    setError(null);
    onClose();
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Import JSON</DialogTitle>
          <DialogDescription>
            Paste an MCP config — a single server, or a{" "}
            <span className="font-mono text-xs">
              {"{"}&quot;mcpServers&quot;: …{"}"}
            </span>{" "}
            block from another tool&rsquo;s docs.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          rows={8}
          placeholder={'{\n  "mcpServers": {\n    "context7": {\n      "command": "npx",\n      "args": ["-y", "@upstash/context7-mcp"]\n    }\n  }\n}'}
          className="font-mono text-xs"
          autoFocus
        />
        {error && (
          <p className="text-red-primary flex items-center gap-1.5 text-xs">
            <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="default"
            size="sm"
            disabled={!text.trim()}
            onClick={handleImport}
          >
            Import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── The page ─────────────────────────────────────────────

export function McpServerFormPage({
  scope,
  index,
  onBack,
}: {
  scope: ResolvedCustomizeScope;
  /** Index of the server being edited in this scope's raw array; null = new. */
  index: number | null;
  onBack: () => void;
}) {
  const isUser = scope.kind === "user";
  const repoRoot = scope.kind === "repo" ? scope.project.repoRoot : undefined;
  const { layer, loading, write } = useSettingsLayer(
    isUser ? "user" : "repo-local",
    repoRoot,
  );
  const servers = useMemo(() => readRawServers(layer?.doc), [layer?.doc]);
  // The user layer is also read at repo scope for the same-name override hint.
  const { layer: userLayer } = useSettingsLayer("user");
  const userNames = useMemo(
    () =>
      new Set(
        readRawServers(userLayer?.doc)
          .map((s) => asString(s.name).trim())
          .filter(Boolean),
      ),
    [userLayer?.doc],
  );

  // Seeded ONCE from the entry as it was when the form opened — a background
  // settings refresh must never clobber typing. `initial` also carries the
  // enabled flag forward through serverFromDraft. Repo scope coerces gateway
  // auth (oauth/header) down to "none": the form SHOWS direct-connection only
  // there, so the draft must match what a save would honestly write (a
  // hand-written repo-local gateway entry is inert anyway — the engine skips
  // it — and editing it here converts it to a direct server, said in the UI).
  const [initial] = useState<RawServer | null>(() =>
    index !== null ? (servers[index] ?? null) : null,
  );
  const [draft, setDraft] = useState<Draft>(() => {
    const seeded = draftFromServer(initial);
    return isUser ? seeded : { ...seeded, auth: "none" };
  });
  // Arguments live as id'd ROWS (not the draft's one-per-line string): a
  // string can't represent a just-added empty row, so deriving rows from it
  // made the first "Add" a silent no-op and unmounted the sole row when its
  // text was cleared. The rows join back into argsText only at save.
  const [argRows, setArgRows] = useState<{ id: number; value: string }[]>(() =>
    draft.argsText.length
      ? draft.argsText.split("\n").map((value) => ({ id: nextKvId(), value }))
      : [],
  );
  const [busy, setBusy] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const editing = initial !== null;
  const bridge = useBridge();

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  // Names taken by OTHER servers in THIS scope (collision guard).
  const takenNames = useMemo(() => {
    const out = new Set<string>();
    servers.forEach((s, i) => {
      if (i === index) return;
      const n = asString(s.name).trim();
      if (n) out.add(n);
    });
    return out;
  }, [servers, index]);

  // The draft the save actually persists: the arg ROWS joined back into the
  // helpers' one-per-line argsText shape.
  const effectiveDraft = useMemo<Draft>(
    () => ({ ...draft, argsText: argRows.map((r) => r.value).join("\n") }),
    [draft, argRows],
  );
  const error = draftError(effectiveDraft, takenNames);
  // A repo server with a user server's name deliberately overrides it there —
  // allowed, but said out loud.
  const overridesUser =
    !isUser && !!draft.name.trim() && userNames.has(draft.name.trim());

  const plainEnv = draft.env.filter((r) => !r.secret);
  const secretEnv = draft.env.filter((r) => r.secret);
  const updateEnvRow = (id: number, patch: Partial<KV>) =>
    set(
      "env",
      draft.env.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    );
  const removeEnvRow = (id: number) =>
    set(
      "env",
      draft.env.filter((r) => r.id !== id),
    );

  const secretScope: McpSecretScope =
    scope.kind === "repo"
      ? { kind: "repo", repoRoot: scope.project.repoRoot }
      : { kind: "user" };

  /** Persist a full servers array for this scope. */
  const persist = async (next: RawServer[]): Promise<boolean> => {
    try {
      await write({ mcp: { servers: next } });
      return true;
    } catch {
      toast.error("Couldn't save MCP servers");
      return false;
    }
  };

  const handleSave = async () => {
    setBusy(true);
    try {
      // Freshly-typed Keychain secrets FIRST (scope-aware accounts), so the
      // file only ever carries the sentinel.
      for (const { name, value } of newSecretsFromDraft(effectiveDraft)) {
        try {
          await setMcpSecret(name, value, secretScope);
        } catch {
          toast.error(`Couldn't store the secret for ${name} in the Keychain`);
        }
      }
      // A freshly-typed auth:"header" secret goes to the engine vault over the
      // LOCAL bridge (user scope only — the auth options are hidden at repo
      // scope), never into settings.
      const headerSecret = isUser ? newHeaderSecretFromDraft(effectiveDraft) : null;
      if (headerSecret && bridge) {
        try {
          await bridgeMcpGatewaySetHeaderSecret(
            bridge,
            headerSecret.url,
            headerSecret.headerName,
            headerSecret.value,
          );
        } catch {
          toast.error("Couldn't store the API key in the secret vault");
        }
      }
      const server = serverFromDraft(effectiveDraft, initial);
      // Re-read the CURRENT array at save time; if the edited entry vanished
      // meanwhile (removed on another device), append instead of clobbering.
      const next =
        index !== null && index < servers.length
          ? servers.map((s, i) => (i === index ? server : s))
          : [...servers, server];
      const ok = await persist(next);
      if (ok) {
        toast.success(editing ? "MCP server saved" : "MCP server added");
        onBack();
      }
    } finally {
      setBusy(false);
    }
  };

  /** Never let a pasted secret land in the TOML (the same rule the adopt
   *  wizard applies): a secret-shaped stdio env value moves to the Keychain
   *  (sentinel in the file; a Keychain failure DROPS the var — reported, never
   *  written plain), and a secret-shaped http header is dropped with a
   *  warning (paste-JSON can't broker gateway auth — add the key via the
   *  form's Authentication options instead). */
  const sanitizeImportedServer = async (s: RawServer): Promise<RawServer> => {
    if (s.transport === "stdio" && s.env && typeof s.env === "object") {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(s.env as Record<string, string>)) {
        if (v && looksSecretEnvName(k)) {
          try {
            await setMcpSecret(k, v, secretScope);
            env[k] = MCP_SECRET_SENTINEL;
          } catch {
            toast.error(
              `Couldn't store ${k} in the Keychain — it was NOT imported (never written in plain text).`,
            );
          }
        } else {
          env[k] = v;
        }
      }
      return { ...s, ...(Object.keys(env).length ? { env } : { env: undefined }) };
    }
    if (s.transport === "http" && s.headers && typeof s.headers === "object") {
      const headers: Record<string, string> = {};
      const dropped: string[] = [];
      for (const [k, v] of Object.entries(s.headers as Record<string, string>)) {
        if (isSecretHeader(k, v)) dropped.push(k);
        else headers[k] = v;
      }
      if (dropped.length) {
        toast.warning(
          `${asString(s.name)}: secret-looking header(s) ${dropped.join(", ")} were not imported — set them via the server's Authentication options instead.`,
        );
      }
      return {
        ...s,
        ...(Object.keys(headers).length ? { headers } : { headers: undefined }),
      };
    }
    return s;
  };

  /** Import-JSON with several servers: append them all (skipping names this
   *  scope already has) and return to the list. */
  const handleImportMany = async (imported: RawServer[]) => {
    const seen = new Set(
      servers.map((s) => asString(s.name).trim()).filter(Boolean),
    );
    const fresh: RawServer[] = [];
    for (const s of imported) {
      const n = asString(s.name).trim();
      if (!n || seen.has(n)) continue;
      seen.add(n);
      fresh.push(s);
    }
    if (fresh.length === 0) {
      toast.warning("Every server in that JSON is already configured here.");
      return;
    }
    setBusy(true);
    try {
      const sanitized: RawServer[] = [];
      for (const s of fresh) sanitized.push(await sanitizeImportedServer(s));
      const ok = await persist([...servers, ...sanitized]);
      if (ok) {
        toast.success(
          `Imported ${sanitized.length} MCP server${sanitized.length === 1 ? "" : "s"}`,
        );
        onBack();
      }
    } finally {
      setBusy(false);
    }
  };

  const scopeLabel = isUser
    ? "every repo (User)"
    : scope.kind === "repo"
      ? scope.project.name
      : "this repo";

  return (
    <div className="flex w-full flex-col gap-8">
      {/* Breadcrumb — the list is one level up; the trail mirrors the page's
          Customize › MCP hierarchy. */}
      <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm">
        <button
          type="button"
          onClick={onBack}
          className="text-fg2 hover:text-fg1 transition-colors"
        >
          MCP
        </button>
        <ChevronRight className="text-fg3 size-3.5" aria-hidden="true" />
        <span className="text-fg1">
          {editing ? "Edit MCP server" : "Add custom MCP"}
        </span>
      </nav>

      <div className="flex flex-col gap-1">
        <p className="text-fg2 m-0 text-xs">
          {editing ? "Edit a custom MCP" : "Add a custom MCP"}
        </p>
        <h1 className="text-fg1 m-0 text-lg leading-tight font-medium">
          {editing
            ? `Edit ${asString(initial?.name) || "MCP server"}`
            : "Create a custom MCP server"}
        </h1>
        <p className="text-fg2 m-0 text-sm">
          Its tools become available to agents in {scopeLabel}. Claude, Codex,
          and Cursor all use it.
        </p>
      </div>

      {/* Identity card — name + description, with the primary actions where
          the reference puts them (top right). */}
      <section className={cn(CARD_CLS, "flex flex-col gap-4 p-4")}>
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 flex-1 flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="mcp-form-name"
                className="text-fg1 text-[14px] font-medium"
              >
                Server name
              </label>
              <Input
                id="mcp-form-name"
                value={draft.name}
                onChange={(e) => set("name", e.target.value)}
                placeholder="e.g., context7"
                className="max-w-md font-mono text-sm"
                autoFocus={!editing}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="mcp-form-desc"
                className="text-fg1 text-[14px] font-medium"
              >
                Short description{" "}
                <span className="text-fg2 font-normal">(optional)</span>
              </label>
              <Textarea
                id="mcp-form-desc"
                value={draft.description}
                onChange={(e) => set("description", e.target.value)}
                placeholder="Brief description of your custom MCP server…"
                rows={2}
                className="max-w-md text-sm"
              />
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Tooltip label="Paste a JSON MCP config">
              <Button
                variant="secondary"
                size="sm"
                className="gap-1.5"
                onClick={() => setImportOpen(true)}
                disabled={busy}
              >
                <ClipboardPaste className="size-3.5" aria-hidden="true" />
                Import JSON
              </Button>
            </Tooltip>
            <Button
              variant="default"
              size="sm"
              className="gap-1.5"
              disabled={!!error || busy || loading}
              onClick={() => void handleSave()}
            >
              {busy && <ZerosSpinner size={16} tone="inverted" />}
              {editing ? "Save" : "Add"}
            </Button>
          </div>
        </div>
        {(error || overridesUser) && (
          <p
            className={cn(
              "m-0 flex items-center gap-1.5 text-xs",
              error ? "text-red-primary" : "text-fg2",
            )}
          >
            <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
            {error ??
              `A User server is also named “${draft.name.trim()}” — this repo's version will override it here.`}
          </p>
        )}
      </section>

      {/* Connection */}
      <div className="flex flex-col gap-3">
        <h2 className="text-fg1 m-0 text-[14px] font-medium">Connection</h2>
        <div className={CARD_ROWS_CLS}>
          <FormRow
            label="Transport type"
            hint="Configure how agents connect to this MCP server"
          >
            <Select
              value={draft.transport}
              onValueChange={(v) => set("transport", v as Transport)}
            >
              <SelectTrigger className="min-w-[140px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="stdio">STDIO</SelectItem>
                <SelectItem value="http">HTTP</SelectItem>
              </SelectContent>
            </Select>
          </FormRow>

          {draft.transport === "stdio" ? (
            <>
              <FormRow
                label="Command"
                hint="The command to run the MCP server process"
                htmlFor="mcp-form-cmd"
              >
                <Input
                  id="mcp-form-cmd"
                  value={draft.command}
                  onChange={(e) => set("command", e.target.value)}
                  placeholder="e.g., python, node, ./script.sh"
                  className="max-w-sm font-mono text-sm"
                />
              </FormRow>
              <FormRow
                label="Arguments"
                hint="Command-line arguments passed to the server process"
                align="start"
              >
                <div className="w-full max-w-sm">
                  <DashedListBox
                    empty="No arguments added"
                    addLabel="Add"
                    hasRows={argRows.length > 0}
                    onAdd={() =>
                      setArgRows([...argRows, { id: nextKvId(), value: "" }])
                    }
                  >
                    {argRows.map((row) => (
                      <ArgRow
                        key={row.id}
                        value={row.value}
                        onChange={(v) =>
                          setArgRows(
                            argRows.map((r) =>
                              r.id === row.id ? { ...r, value: v } : r,
                            ),
                          )
                        }
                        onRemove={() =>
                          setArgRows(argRows.filter((r) => r.id !== row.id))
                        }
                      />
                    ))}
                  </DashedListBox>
                </div>
              </FormRow>
            </>
          ) : (
            <>
              <FormRow
                label="URL"
                hint="Streamable-HTTP endpoint"
                htmlFor="mcp-form-url"
              >
                <Input
                  id="mcp-form-url"
                  value={draft.url}
                  onChange={(e) => set("url", e.target.value)}
                  placeholder="https://mcp.example.com/mcp"
                  className="max-w-sm font-mono text-sm"
                />
              </FormRow>
              {isUser ? (
                <FormRow
                  label="Authentication"
                  hint={
                    draft.auth === "oauth"
                      ? "The Zeros gateway signs in once in your browser and holds the token — shared across all agents."
                      : draft.auth === "header"
                        ? "The gateway holds your API key and adds it when proxying — the key never touches the settings file."
                        : "Direct connection with the headers below."
                  }
                >
                  <Select
                    value={draft.auth}
                    onValueChange={(v) => set("auth", v as Draft["auth"])}
                  >
                    <SelectTrigger className="min-w-[220px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">None / static headers</SelectItem>
                      <SelectItem value="header">
                        API key / header (via gateway)
                      </SelectItem>
                      <SelectItem value="oauth">OAuth (via gateway)</SelectItem>
                    </SelectContent>
                  </Select>
                </FormRow>
              ) : (
                // Repo scope: the gateway is user-global, so brokered auth
                // (OAuth / held API keys) lives on User servers only.
                <FormRow
                  label="Authentication"
                  hint="Repo servers connect directly with the headers below. For OAuth or a gateway-held API key, add the server at the User scope instead."
                >
                  <span className="text-fg2 text-sm">None / static headers</span>
                </FormRow>
              )}
              {isUser && draft.auth === "header" && (
                <>
                  <FormRow
                    label="Header name"
                    hint="The gateway sets this on every request"
                  >
                    <Input
                      value={draft.headerName}
                      onChange={(e) => set("headerName", e.target.value)}
                      placeholder="Authorization"
                      className="max-w-sm font-mono text-sm"
                    />
                  </FormRow>
                  <FormRow
                    label="API key / token"
                    hint="Stored encrypted in the engine's secret vault — never the settings file or a command line"
                  >
                    <Input
                      type="password"
                      value={draft.headerSecret}
                      onChange={(e) => set("headerSecret", e.target.value)}
                      placeholder={
                        editing ? "•••••••• — leave blank to keep" : "Bearer sk-…"
                      }
                      className="max-w-sm font-mono text-sm"
                      autoComplete="off"
                    />
                  </FormRow>
                </>
              )}
              {isUser && draft.auth === "oauth" && (
                <FormRow
                  label="Client ID"
                  hint="Advanced — only for servers that require a pre-registered OAuth client. Leave blank to auto-register."
                >
                  <Input
                    value={draft.oauthClientId}
                    onChange={(e) => set("oauthClientId", e.target.value)}
                    placeholder="(optional) client_id"
                    className="max-w-sm font-mono text-sm"
                    autoComplete="off"
                  />
                </FormRow>
              )}
              {(!isUser || draft.auth === "none") && (
                <FormRow
                  label="Headers"
                  hint="Sent on every request. Written to the settings file in plain text — don't put a real secret here."
                  align="start"
                >
                  <div className="w-full max-w-md">
                    <DashedListBox
                      empty="No headers added"
                      addLabel="Add header"
                      hasRows={draft.headers.length > 0}
                      onAdd={() =>
                        set("headers", [
                          ...draft.headers,
                          { id: nextKvId(), key: "", value: "" },
                        ])
                      }
                    >
                      {draft.headers.map((row) => (
                        <KvRow
                          key={row.id}
                          row={row}
                          keyPlaceholder="X-Header"
                          valuePlaceholder="value"
                          onChange={(patch) =>
                            set(
                              "headers",
                              draft.headers.map((r) =>
                                r.id === row.id ? { ...r, ...patch } : r,
                              ),
                            )
                          }
                          onRemove={() =>
                            set(
                              "headers",
                              draft.headers.filter((r) => r.id !== row.id),
                            )
                          }
                        />
                      ))}
                    </DashedListBox>
                  </div>
                </FormRow>
              )}
            </>
          )}
        </div>
      </div>

      {draft.transport === "stdio" && (
        <>
          <ListCard
            title="Environment variables"
            hint="Set when running the server process. Plain values land in the settings file — put anything sensitive under Secrets instead."
            action={
              <Button
                variant="secondary"
                size="sm"
                className="gap-1.5"
                onClick={() =>
                  set("env", [
                    ...draft.env,
                    { id: nextKvId(), key: "", value: "" },
                  ])
                }
              >
                <Plus className="size-3.5" aria-hidden="true" />
                Add
              </Button>
            }
          >
            <DashedListBox
              empty="No environment variables added"
              addLabel="Add"
              hasRows={plainEnv.length > 0}
              onAdd={() =>
                set("env", [...draft.env, { id: nextKvId(), key: "", value: "" }])
              }
            >
              {plainEnv.map((row) => (
                <KvRow
                  key={row.id}
                  row={row}
                  keyPlaceholder="NAME"
                  valuePlaceholder="value"
                  onChange={(patch) => updateEnvRow(row.id, patch)}
                  onRemove={() => removeEnvRow(row.id)}
                />
              ))}
            </DashedListBox>
          </ListCard>

          <ListCard
            title="Secrets"
            hint="Stored in your macOS Keychain and passed to the server process at spawn — never written to the settings file."
            action={
              <Button
                variant="secondary"
                size="sm"
                className="gap-1.5"
                onClick={() =>
                  set("env", [
                    ...draft.env,
                    { id: nextKvId(), key: "", value: "", secret: true },
                  ])
                }
              >
                <Plus className="size-3.5" aria-hidden="true" />
                Add secret
              </Button>
            }
          >
            <DashedListBox
              empty="No secrets added"
              addLabel="Add secret"
              hasRows={secretEnv.length > 0}
              onAdd={() =>
                set("env", [
                  ...draft.env,
                  { id: nextKvId(), key: "", value: "", secret: true },
                ])
              }
            >
              {secretEnv.map((row) => (
                <KvRow
                  key={row.id}
                  row={row}
                  keyPlaceholder="SECRET_NAME"
                  valuePlaceholder={
                    editing && row.value === ""
                      ? "•••• stored — type to replace"
                      : "value"
                  }
                  password
                  onChange={(patch) => updateEnvRow(row.id, patch)}
                  onRemove={() => removeEnvRow(row.id)}
                />
              ))}
            </DashedListBox>
          </ListCard>
        </>
      )}

      <ImportJsonDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onSingle={(server) => {
          // Seed the whole form from the pasted config; keep an existing
          // typed name if the paste has none. Secret-looking env values seed
          // as SECRET rows (Keychain on save, sentinel in the file) — the
          // same protection the adopt wizard applies on import.
          const seeded = draftFromServer(server);
          setDraft((d) => ({
            ...seeded,
            env: seeded.env.map((kv) =>
              kv.value && looksSecretEnvName(kv.key)
                ? { ...kv, secret: true }
                : kv,
            ),
            auth: isUser ? seeded.auth : "none",
            name: seeded.name || d.name,
            description: d.description,
          }));
          setArgRows(
            seeded.argsText.length
              ? seeded.argsText
                  .split("\n")
                  .map((value) => ({ id: nextKvId(), value }))
              : [],
          );
        }}
        onMany={(list) => void handleImportMany(list)}
      />
    </div>
  );
}
