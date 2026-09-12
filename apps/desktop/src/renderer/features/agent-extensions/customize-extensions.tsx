import React, { useEffect, useId, useState } from "react";
import type {
  ExtensionEntry,
  ExtensionQuery,
} from "@zeros/protocol/agent-extensions";
import { zerosSkillSchema } from "@zeros/protocol/agent-extensions";
import { ArrowLeft, Plus } from "lucide-react";
import { Button, Input, Textarea } from "../../shared/ui";
import { useBridge, useBridgeStatus } from "../../platform/bridge/use-bridge";
import { workspaceOp } from "../../platform/bridge/workspace-bridge";
import { useCachedRead } from "../../state/use-cached-read";
import { createExtensionResource, extensionResource } from "./extensions-cache";

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
  const save = async () => {
    if (!bridge || bridge.executionIdentity.kind !== "local" || busy) return;
    const parsed = zerosSkillSchema.safeParse({ name, description, body });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check the skill fields.");
      return;
    }
    setBusy(true);
    setError(null);
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
  return (
    <form
      className="flex max-w-2xl flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div>
        <Button type="button" variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="size-4" /> Skills
        </Button>
      </div>
      <h2 className="text-fg1 text-base font-medium">
        {entry ? "Edit skill" : "New skill"}
      </h2>
      <label className="text-fg1 flex flex-col gap-2 text-sm">
        Name
        <Input
          value={name}
          disabled={Boolean(entry) || busy}
          onChange={(event) => setName(event.target.value)}
          placeholder="review-changes"
          maxLength={64}
          required
        />
      </label>
      <label className="text-fg1 flex flex-col gap-2 text-sm">
        When to use it
        <Input
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="Review changes for correctness and missing tests"
          maxLength={1000}
          required
        />
      </label>
      <div className="text-fg1 flex flex-col gap-2 text-sm">
        <label htmlFor={`${formId}-instructions`}>Instructions</label>
        <Textarea
          id={`${formId}-instructions`}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={14}
          maxLength={65536}
          required
        />
      </div>
      <p className="text-fg2 text-xs">
        {query.repoRoot
          ? "Saved privately for this repository and its local workspaces."
          : "Available to agents in all your local repositories."}{" "}
        Skills guide the agent using its available tools and permissions. New
        sessions discover saved skills automatically.
      </p>
      {error && (
        <p role="alert" className="text-danger-fg text-sm">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={!bridge || busy}>
          {busy ? "Saving…" : "Save skill"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={busy}
          onClick={onBack}
        >
          Cancel
        </Button>
      </div>
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
  const key = resource.key(query);
  const read = useCachedRead(
    resource.cache,
    isLocal ? key : null,
    resource.fetch,
    {
      enabled: isLocal && surfaceActive && status === "connected",
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
      <p className="text-fg2 text-sm">
        Personal customization is available in a local workspace.
      </p>
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
  return (
    <section
      className="flex flex-col gap-4"
      aria-label={`${query.provider} ${LABELS[query.category]}`}
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-fg1 text-sm font-medium">
          {LABELS[query.category]}
        </h2>
        <Button
          variant="ghost"
          size="sm"
          onClick={read.refresh}
          disabled={status !== "connected" || read.loading || read.refreshing}
        >
          {read.refreshing ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
      {read.data?.note && <p className="text-fg2 text-sm">{read.data.note}</p>}
      {(error || read.error) && (
        <p role="alert" className="text-danger-fg text-sm">
          {error || read.error?.message}
        </p>
      )}
      {read.data?.warnings.map((warning) => (
        <p key={warning} className="text-fg2 text-sm">
          {warning}
        </p>
      ))}
      {status !== "connected" && (
        <p className="text-fg2 text-sm">
          Connect to the local engine to load customization.
        </p>
      )}
      {read.loading && !read.data && (
        <p className="text-fg2 text-sm" role="status">
          Reading {LABELS[query.category].toLowerCase()}…
        </p>
      )}
      {read.data?.entries.map((entry) => (
        <div
          key={entry.id}
          className="border-border2 flex flex-col gap-2 rounded-md border p-4"
        >
          <div className="flex items-start justify-between gap-3">
            <h3 className="text-fg1 min-w-0 text-sm font-medium break-words">
              {entry.name}
            </h3>
            <span className="text-fg2 shrink-0 text-xs">
              {STATUS[entry.status]}
            </span>
          </div>
          {entry.description && (
            <p className="text-fg2 text-sm">{entry.description}</p>
          )}
          {entry.statusDetail && (
            <p className="text-fg2 text-xs">{entry.statusDetail}</p>
          )}
          {entry.components?.length ? (
            <p className="text-fg2 text-xs">
              Includes {entry.components.join(", ")}
            </p>
          ) : null}
          <p className="text-fg3 text-xs break-all">{entry.sourcePath}</p>
          {editable && (
            <div className="flex items-center gap-2">
              {removing === entry.id ? (
                <>
                  <span className="text-fg2 text-xs">Remove this skill?</span>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void remove(entry)}
                  >
                    Remove
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setRemoving(null)}
                  >
                    Cancel
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setEditing({ entry })}
                  >
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setRemoving(entry.id)}
                  >
                    Remove
                  </Button>
                </>
              )}
            </div>
          )}
        </div>
      ))}
      {read.data && !read.data.entries.length && (
        <p className="text-fg2 py-3 text-sm">
          {editable
            ? "No Zeros skills in this scope yet."
            : "No entries reported for this scope."}
        </p>
      )}
      {editable && (
        <button
          type="button"
          onClick={() => setEditing({ entry: null })}
          className="border-border2 text-fg2 hover:bg-bg2 flex h-24 items-center justify-center gap-2 rounded-md border border-dashed text-sm"
        >
          <Plus className="size-4" /> New skill
        </button>
      )}
    </section>
  );
}
