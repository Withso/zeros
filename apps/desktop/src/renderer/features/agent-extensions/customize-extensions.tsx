import React, { useEffect, useId, useState, useSyncExternalStore } from "react";
import type {
  ExtensionEntry,
  ExtensionQuery,
} from "@zeros/protocol/agent-extensions";
import { zerosSkillSchema } from "@zeros/protocol/agent-extensions";
import { ChevronRight, Ellipsis } from "lucide-react";
import { Button, Input, Textarea } from "../../shared/ui";
import { Badge } from "../../shared/ui/primitives/badge";
import { Field } from "../../shared/ui/primitives/field";
import { IconButton } from "../../shared/ui/primitives/icon-button";
import { MessageRow } from "../../shared/ui/primitives/message-row";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../shared/ui/primitives/dropdown-menu";
import {
  SettingsAddRow,
  SettingsEmpty,
  SettingsGroup,
  SettingsList,
  SettingsRow,
} from "../settings/settings-ui";
import { useBridge, useBridgeStatus } from "../../platform/bridge/use-bridge";
import { workspaceOp } from "../../platform/bridge/workspace-bridge";
import { useRecoveringRead } from "../../state/use-recovering-read";
import { createExtensionResource, extensionResource } from "./extensions-cache";
import {
  providerAuthRevision,
  subscribeProviderAuth,
} from "../../platform/provider-auth-state";

const disconnectedResource = createExtensionResource(() =>
  Promise.reject(
    new Error("Connect to the local engine to view customization."),
  ),
);
const LABELS = {
  mcp: "MCP servers",
  skills: "Skills",
  plugins: "Plugins",
  apps: "Apps and connectors",
};
const STATUS = {
  available: "Available",
  "needs-auth": "Sign-in required",
  unavailable: "Unavailable in Zeros",
  configured: "Configured",
  disabled: "Disabled in native config",
  found: "Found on disk",
};

function SkillForm({
  entry,
  query,
  onBack,
  onSaved,
}: {
  entry: ExtensionEntry | null;
  query: ExtensionQuery;
  onBack: () => void;
  onSaved: () => void;
}) {
  const bridge = useBridge();
  const formId = useId();
  const [name, setName] = useState(entry?.id ?? "");
  const [description, setDescription] = useState(entry?.description ?? "");
  const [body, setBody] = useState(entry?.body ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<{ field: "name" | "description" | "body"; message: string } | null>(null);
  const save = async () => {
    if (!bridge || bridge.executionIdentity.kind !== "local" || busy) return;
    const parsed = zerosSkillSchema.safeParse({ name, description, body });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = issue?.path[0];
      const message = issue?.message ?? "Check the skill fields.";
      if (field === "name" || field === "description" || field === "body") {
        setFieldError({ field, message });
        setError(null);
      } else setError(message);
      return;
    }
    setBusy(true);
    setError(null);
    setFieldError(null);
    try {
      await workspaceOp(bridge, "skills.saveZeros", {
        ...parsed.data,
        repoRoot: query.repoRoot,
        expectedRevision: entry?.revision ?? null,
      });
      onSaved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const heading = entry ? "Edit skill" : "New skill";
  const errorFor = (field: "name" | "description" | "body") =>
    fieldError?.field === field ? fieldError.message : undefined;
  return (
    <form
      className="flex min-w-0 flex-col gap-8"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {/* The MCP editor's layout: a breadcrumb back, the title with its one
          action, then one card of fields. */}
      <div className="flex flex-col gap-3">
        <nav aria-label="Breadcrumb" className="text-fg3 flex items-center gap-1 text-xs leading-4.5">
          <Button type="button" variant="ghost" size="compact" onClick={onBack} disabled={busy}>
            Skills
          </Button>
          <ChevronRight className="size-3.5" aria-hidden="true" />
          <span>{heading}</span>
        </nav>
        <div className="flex items-start justify-between gap-3">
          <h1 className="text-fg1 m-0 text-lg leading-6 font-medium">{heading}</h1>
          <Button type="submit" variant="primary" loading={busy} disabled={!bridge}>
            {busy ? "Saving…" : "Save skill"}
          </Button>
        </div>
      </div>
      {error && (
        <MessageRow tone="error" role="alert" flush>
          {error}
        </MessageRow>
      )}
      <SettingsGroup
        title="Skill"
        description={
          query.repoRoot
            ? "For this repository and its local workspaces."
            : "Available in all your local repositories."
        }
      >
        <Field label="Name" error={errorFor("name")}>
          <Input
            value={name}
            disabled={Boolean(entry) || busy}
            onChange={(event) => setName(event.target.value)}
            placeholder="review-changes"
            maxLength={64}
            required
          />
        </Field>
        <Field label="When to use it" error={errorFor("description")}>
          <Input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Review changes for correctness and missing tests"
            maxLength={1000}
            required
          />
        </Field>
        <Field label="Instructions" error={errorFor("body")}>
          <Textarea
            id={`${formId}-instructions`}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            rows={14}
            maxLength={65536}
            required
          />
        </Field>
      </SettingsGroup>
    </form>
  );
}

/** Mounted under an exact scope/category/provider key. A draft cannot move to
 * another repository when navigation changes or its owner is removed. */
export function CustomizeExtensionsSection({
  query,
  surfaceActive,
}: {
  query: ExtensionQuery;
  surfaceActive: boolean;
}) {
  const bridge = useBridge();
  const status = useBridgeStatus();
  const isLocal = bridge?.executionIdentity.kind !== "cloud";
  const resource = bridge ? extensionResource(bridge) : disconnectedResource;
  useSyncExternalStore(
    subscribeProviderAuth,
    providerAuthRevision,
    providerAuthRevision,
  );
  const key = resource.key(query);
  const read = useRecoveringRead(
    resource.cache,
    isLocal ? key : null,
    resource.fetch,
    {
      enabled: isLocal && surfaceActive && status === "connected",
      connected: status === "connected",
      maxAgeMs: 30_000,
    },
  );
  const [editing, setEditing] = useState<{
    entry: ExtensionEntry | null;
  } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editable = query.provider === "zeros" && query.category === "skills";
  useEffect(() => {
    if (!bridge || !surfaceActive || !isLocal) return;
    const off = bridge.on("DB_CHANGED", (msg) => {
      if ((msg as { kinds?: string[] }).kinds?.includes("settings"))
        resource.cache.invalidateAll();
    });
    const onFocus = () => resource.cache.invalidate(key);
    window.addEventListener("focus", onFocus);
    return () => {
      off();
      window.removeEventListener("focus", onFocus);
    };
  }, [bridge, surfaceActive, resource, key, isLocal]);
  const changed = () => {
    resource.cache.invalidateAll();
    setEditing(null);
    setRemoving(null);
  };
  const remove = async (entry: ExtensionEntry) => {
    if (
      !bridge ||
      bridge.executionIdentity.kind !== "local" ||
      !entry.revision ||
      busy
    )
      return;
    setBusy(true);
    setError(null);
    try {
      await workspaceOp(bridge, "skills.removeZeros", {
        name: entry.id,
        repoRoot: query.repoRoot,
        expectedRevision: entry.revision,
      });
      changed();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  if (!isLocal)
    return (
      <SettingsEmpty
        title="Skills live in local workspaces"
        hint="Open a local workspace to edit them."
      />
    );
  if (editable && editing)
    return (
      <SkillForm
        entry={editing.entry}
        query={query}
        onBack={() => setEditing(null)}
        onSaved={changed}
      />
    );
  const label = LABELS[query.category];
  const loadingFirst = read.loading && !read.data;
  return (
    <section
      className="flex flex-col gap-2"
      aria-label={`${query.provider} ${label}`}
    >
      <div className="flex items-end justify-between gap-4 px-0.5">
        <p className="text-fg3 m-0 text-3xxs leading-4">
          {editable ? "Agents use these in new chats." : label}
        </p>
        <Button
          variant="ghost"
          size="compact"
          className="text-fg2 shrink-0"
          onClick={read.refresh}
          disabled={status !== "connected" || read.loading || read.refreshing}
        >
          {read.refreshing ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
      {read.data?.note && <p className="text-fg3 m-0 px-0.5 text-3xxs leading-4">{read.data.note}</p>}
      {read.data?.account && (
        <p className="text-fg3 m-0 px-0.5 text-3xxs leading-4">
          {query.provider === "codex" ? "Codex" : "Claude"} account:{" "}
          {read.data.account.label}
        </p>
      )}
      {read.data?.sources?.map((source) => (
        <p key={source.id} className="text-fg3 m-0 px-0.5 text-3xxs leading-4">
          {source.kind === "local"
            ? "This machine"
            : source.kind === "account"
              ? "Provider account"
              : "Provider session"}
          :{" "}
          {source.state === "complete"
            ? "Checked"
            : source.state === "partial"
              ? "Incomplete"
              : source.state === "unsupported"
                ? "Account listing unavailable"
                : source.state === "needs-auth"
                  ? "Sign-in required"
                  : "Start a session to check"}
          .{source.detail ? ` ${source.detail}` : ""}
        </p>
      ))}
      <SettingsList aria-busy={loadingFirst || undefined}>
        {status !== "connected" ? (
          <MessageRow tone="warning" flush>
            Can’t reach the local engine.
          </MessageRow>
        ) : null}
        {(error || read.error) && (
          <MessageRow
            tone="error"
            role="alert"
            flush
            actions={
              read.error && !error ? (
                <Button variant="ghost" size="compact" onClick={read.refresh}>
                  Retry
                </Button>
              ) : undefined
            }
          >
            {error || read.error?.message}
          </MessageRow>
        )}
        {read.data?.warnings.map((warning) => (
          <MessageRow key={warning} tone="warning" flush>
            {warning}
          </MessageRow>
        ))}
        {loadingFirst && status === "connected" && (
          <MessageRow tone="pending" role="status" flush>
            {`Loading ${label.toLowerCase()}…`}
          </MessageRow>
        )}
        {read.data?.entries.map((entry) =>
          removing === entry.id ? (
            <SettingsRow key={entry.id} label={entry.name} hint="Remove this skill?">
              <Button variant="ghost" size="compact" onClick={() => setRemoving(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive-secondary"
                size="compact"
                loading={busy}
                onClick={() => void remove(entry)}
              >
                Remove
              </Button>
            </SettingsRow>
          ) : (
            <SettingsRow
              key={entry.id}
              label={<span className="block truncate">{entry.name}</span>}
              hint={entry.description ? <span className="line-clamp-1">{entry.description}</span> : undefined}
            >
              {/* Status shows only when the skill needs the person. */}
              {entry.status !== "available" && (
                <Badge variant={entry.status === "needs-auth" ? "warning" : "neutral"}>
                  {STATUS[entry.status]}
                </Badge>
              )}
              {editable && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <IconButton size="compact" label={`More actions for ${entry.name}`} disabled={busy}>
                      <Ellipsis />
                    </IconButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => setEditing({ entry })}>Edit</DropdownMenuItem>
                    <DropdownMenuItem variant="destructive" onSelect={() => setRemoving(entry.id)}>
                      Remove
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </SettingsRow>
          ),
        )}
        {read.data && !read.data.entries.length && (
          <p className="text-fg2 m-0 text-xs leading-4.5">
            {editable ? "No skills yet." : "No entries reported for this scope."}
          </p>
        )}
        {editable && (
          <SettingsAddRow label="New skill" onClick={() => setEditing({ entry: null })} />
        )}
      </SettingsList>
    </section>
  );
}
