// PURPOSE: Theme sources in the theme editor. The rail switches between the
// manual tokens (tokens.css) and each imported style source declared in
// meta/canvas.json; the status strip explains what a source imported.
// Imported tokens are read-only here: their repository file owns them.
import { CircleCheck, CircleX, MessageSquarePlus, RefreshCw, TriangleAlert } from "lucide-react";

import type {
  DesignStyleSourceWire,
  DesignTokenWire,
} from "../../platform/git";
import { Button, Tooltip } from "../../shared/ui/primitives";
import { cn } from "../../shared/ui/cn";

const STATUS = {
  ready: { Icon: CircleCheck, label: "Ready", className: "text-green-primary" },
  warning: {
    Icon: TriangleAlert,
    label: "Warning",
    className: "text-yellow-primary",
  },
  error: { Icon: CircleX, label: "Error", className: "text-red-primary" },
} as const;

/** A newer cloud engine may report a status this build does not know yet. */
function sourceStatus(status: string): (typeof STATUS)[keyof typeof STATUS] {
  return STATUS[status as keyof typeof STATUS] ?? STATUS.warning;
}

/** Imported tokens in the editor's row shape, so search and type filters apply. */
export function designStyleSourceTokens(
  source: DesignStyleSourceWire,
): DesignTokenWire[] {
  return source.tokens.map((token, index) => ({
    name: token.name,
    syntax: "*",
    inherits: true,
    initialValue: token.value,
    value: token.value,
    themeValues: token.themeValues,
    usageCount: 0,
    line: index + 1,
  }));
}

/** A message the person's agent resolves by changing the declaration. */
export function designStyleSourceNeedsAgent(source: DesignStyleSourceWire): boolean {
  return source.messages.some((message) => message.action === "agent");
}

export function DesignThemeSourceRail({
  sources,
  errors,
  manualCount,
  selectedId,
  onSelect,
  onAskAgent,
  onUpdate,
  updating = false,
}: {
  sources: readonly DesignStyleSourceWire[];
  errors: readonly string[];
  manualCount: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Nothing syncs on its own: the person's agent sets syncing up, or fixes
   * the declaration list. Absent when no workspace can host a chat. */
  onAskAgent?: () => void;
  /** Re-read every source now; syncing is otherwise live. */
  onUpdate?: () => void;
  updating?: boolean;
}) {
  return (
    <div role="group" aria-label="Theme sources" className="zd-theme-sources">
      <div className="zd-theme-rail-heading">
        <div className="zd-theme-rail-label">Sources</div>
        {sources.length > 0 && onUpdate ? (
          <Tooltip
            className="zd-theme-tooltip"
            label="Update sources"
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-compact"
              className="zd-icon-button"
              data-design-theme-update=""
              aria-label={updating ? "Updating sources" : "Update sources"}
              disabled={updating}
              onClick={onUpdate}
            >
              <RefreshCw
                aria-hidden="true"
                className={updating ? "animate-spin" : undefined}
              />
            </Button>
          </Tooltip>
        ) : null}
      </div>
      <Button
        type="button"
        variant="ghost"
        className="zd-theme-filter w-full"
        aria-pressed={selectedId === null}
        onClick={() => onSelect(null)}
      >
        <span className="truncate">Manual</span>
        <span className="zd-theme-filter-count">{manualCount}</span>
      </Button>
      {sources.map((source) => {
        const status = sourceStatus(source.status);
        return (
          <Tooltip
            key={source.id}
            className="zd-theme-tooltip"
            label={`${source.path} · ${status.label}`}
          >
            <Button
              type="button"
              variant="ghost"
              className="zd-theme-filter w-full"
              aria-pressed={selectedId === source.id}
              aria-label={`${source.title}, ${status.label}`}
              onClick={() => onSelect(source.id)}
            >
              <span className="zd-theme-source-name">
                <status.Icon
                  aria-hidden="true"
                  className={cn("size-3.5 shrink-0", status.className)}
                />
                <span className="truncate">{source.title}</span>
              </span>
              <span className="zd-theme-filter-count">
                {source.tokens.length}
              </span>
            </Button>
          </Tooltip>
        );
      })}
      {errors.length > 0 ? (
        <Tooltip className="zd-theme-tooltip" label={errors.join("\n")}>
          <p role="status" tabIndex={0} className="zd-theme-source-errors">
            <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0" />
            <span>
              {errors.length === 1
                ? "1 declaration problem"
                : `${errors.length} declaration problems`}
            </span>
          </p>
        </Tooltip>
      ) : null}
      {sources.length === 0 && onAskAgent ? (
        <Button
          type="button"
          variant="ghost"
          className="zd-theme-filter w-full"
          data-design-theme-ask-agent=""
          onClick={onAskAgent}
        >
          <span className="zd-theme-source-name">
            <MessageSquarePlus aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="truncate">Ask agent to sync</span>
          </span>
        </Button>
      ) : null}
      {errors.length > 0 && onAskAgent ? (
        <Button
          type="button"
          variant="ghost"
          className="zd-theme-filter w-full"
          data-design-theme-fix-declarations=""
          onClick={onAskAgent}
        >
          <span className="zd-theme-source-name">
            <MessageSquarePlus aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="truncate">Ask agent to fix</span>
          </span>
        </Button>
      ) : null}
    </div>
  );
}

export function DesignThemeSourceStatus({
  source,
  overriddenCount = 0,
  onAskAgentToFix,
}: {
  source: DesignStyleSourceWire;
  /** Variables Manual tokens redeclare, which frames take from tokens.css. */
  overriddenCount?: number;
  /** Shown only when the source's declaration itself needs changing. */
  onAskAgentToFix?: () => void;
}) {
  const status = sourceStatus(source.status);
  const count = source.tokens.length;
  return (
    <div
      role="status"
      data-design-theme-source-status=""
      className="zd-theme-source-status"
    >
      <div className="zd-theme-source-heading">
        <status.Icon
          aria-hidden="true"
          className={cn("size-3.5 shrink-0", status.className)}
        />
        <span className="zd-theme-source-title">{source.title}</span>
        <code className="zd-theme-source-path">{source.path}</code>
        <span className="zd-theme-source-summary">
          {source.status === "error"
            ? "Not imported"
            : `${count} ${count === 1 ? "variable" : "variables"} · read-only`}
        </span>
        {onAskAgentToFix && designStyleSourceNeedsAgent(source) ? (
          <Button
            type="button"
            variant="ghost"
            size="compact"
            data-design-theme-source-fix=""
            onClick={onAskAgentToFix}
          >
            <MessageSquarePlus aria-hidden="true" className="size-3.5 shrink-0" />
            Ask agent to fix
          </Button>
        ) : null}
      </div>
      {source.messages.length > 0 || overriddenCount > 0 ? (
        <ul className="zd-theme-source-messages">
          {source.messages.map((message, index) => (
            <li key={`${message.level}:${index}`} data-level={message.level}>
              {message.text}
            </li>
          ))}
          {overriddenCount > 0 ? (
            <li data-level="warning" data-design-theme-overridden="">
              {overriddenCount === 1
                ? "1 variable is overridden by Manual tokens (tokens.css), so frames use the Manual value."
                : `${overriddenCount} variables are overridden by Manual tokens (tokens.css), so frames use the Manual values.`}
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
