import { memo, useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  LoaderCircle,
  X,
} from "lucide-react";
import {
  sessionToolGroups,
  type SessionToolsInventorySnapshot,
  type SessionToolInventoryEntry,
} from "@zeros/protocol/agent-extensions";
import { Button } from "../../shared/ui/primitives/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../../shared/ui/primitives/elements/collapsible";

const LABELS = { plugins: "Plugins", apps: "Apps", mcp: "MCPs" } as const;
const STATUS_LABELS = {
  connected: "Connected",
  available: "Available",
  enabled: "Enabled",
  loaded: "Loaded",
  connecting: "Connecting",
  disabled: "Disabled",
  unavailable: "Unavailable",
  unverified: "Not verified",
  "needs-auth": "Error",
  error: "Error",
} satisfies Record<SessionToolInventoryEntry["status"], string>;

export const ComposerToolGroups = memo(function ComposerToolGroups({
  snapshot,
  authBusy,
  onAuthenticate,
}: {
  snapshot: SessionToolsInventorySnapshot;
  authBusy: string | null;
  onAuthenticate: (id: string) => void;
}) {
  const groups = useMemo(
    () =>
      sessionToolGroups(snapshot).filter((group) => group.entries.length > 0),
    [snapshot],
  );
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  if (groups.length === 0)
    return (
      <p role="status" className="text-fg2 text-xs">
        {snapshot.state === "pending"
          ? "Loading tools…"
          : "No tools reported for this session."}
      </p>
    );
  return (
    <div className="max-h-80 overflow-y-auto" data-tool-groups="">
      {groups.map((group) => {
        const open = expanded.has(group.kind);
        const label = LABELS[group.kind];
        const count =
          group.state === "unsupported" ||
          (group.state === "partial" && !group.entries.length)
            ? "—"
            : `${group.entries.length}${group.state === "partial" ? "*" : ""}`;
        return (
          <Collapsible
            key={group.kind}
            open={open}
            data-tool-group={group.kind}
            onOpenChange={(next) =>
              setExpanded((previous) => {
                const changed = new Set(previous);
                if (next) changed.add(group.kind);
                else changed.delete(group.kind);
                return changed;
              })
            }
          >
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-full justify-start gap-2"
                aria-label={`${label}, ${count === "—" ? "not reported" : count}`}
                title={
                  group.state === "partial" ? "Incomplete inventory" : undefined
                }
              >
                {open ? (
                  <ChevronDown className="text-fg2 size-3.5" />
                ) : (
                  <ChevronRight className="text-fg2 size-3.5" />
                )}
                <span className="min-w-0 flex-1 text-left">{label}</span>
                <span
                  className="text-fg2 text-xs tabular-nums"
                  data-tool-group-count=""
                >
                  {count}
                </span>
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              {group.entries.length > 0 && (
                <ul aria-label={label}>
                  {group.entries.map((entry) => (
                    <li
                      key={entry.id}
                      data-tool-id={entry.id}
                      className="flex min-h-8 items-center gap-2 px-2 py-1 text-sm"
                    >
                      <div
                        className="text-fg1 min-w-0 flex-1 truncate"
                        title={entry.name}
                      >
                        {entry.name}
                      </div>
                      <ToolStatus
                        entry={entry}
                        canAuthenticate={
                          group.kind === "mcp" && entry.canAuthenticate === true
                        }
                        authBusy={authBusy}
                        onAuthenticate={onAuthenticate}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </CollapsibleContent>
          </Collapsible>
        );
      })}
    </div>
  );
});

function ToolStatus({
  entry,
  canAuthenticate,
  authBusy,
  onAuthenticate,
}: {
  entry: SessionToolInventoryEntry;
  canAuthenticate: boolean;
  authBusy: string | null;
  onAuthenticate: (id: string) => void;
}) {
  const label = STATUS_LABELS[entry.status];
  if (
    entry.status === "connected" ||
    entry.status === "available" ||
    entry.status === "enabled" ||
    entry.status === "loaded"
  ) {
    return (
      <span role="img" aria-label={label} title={label} className="shrink-0">
        <Check className="text-green-primary size-4" />
      </span>
    );
  }
  if (entry.status === "connecting")
    return (
      <span
        role="status"
        aria-label="Connecting"
        title="Connecting"
        className="shrink-0"
      >
        <LoaderCircle className="text-fg2 size-3.5 animate-spin motion-reduce:animate-none" />
      </span>
    );
  if (canAuthenticate)
    return (
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="text-blue-fg h-auto shrink-0 bg-transparent p-0 hover:bg-transparent hover:text-(--composer-tool-action-hover)"
        disabled={authBusy !== null}
        aria-label={`Authenticate ${entry.name}`}
        onClick={() => onAuthenticate(entry.id)}
      >
        {authBusy === entry.id ? "Opening…" : "Authenticate"}
      </Button>
    );
  return (
    <span role="img" aria-label={label} title={label} className="shrink-0">
      <X className="text-red-primary size-4" />
    </span>
  );
}
