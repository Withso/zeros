import { TriangleAlert } from "lucide-react";
import type React from "react";
import type { DesignLintViolationWire } from "../../platform/git";
import { cn } from "../../shared/ui/cn";
import { Button, Popover, PopoverContent, PopoverTrigger } from "../../shared/ui/primitives";
import { designFrameLintBadgeLabel, groupDesignLintViolations } from "./design-lint-summary";

/** Runtime audits report one finding per layer; a frame can carry hundreds. */
const ROWS_PER_RULE = 20;

const stop = (event: React.SyntheticEvent) => event.stopPropagation();

export function DesignFrameLintBadge({ title, violations, onSelectLayer }: {
  title: string;
  violations: readonly DesignLintViolationWire[];
  onSelectLayer: (oid: string) => void;
}) {
  if (violations.length === 0) return null;
  const errors = violations.some((violation) => violation.severity === "error");
  const label = designFrameLintBadgeLabel(violations);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="compact"
          data-design-frame-lint=""
          data-severity={errors ? "error" : "warning"}
          aria-label={`${label} in ${title}`}
          title={label}
          className={cn(
            "text-2xxs h-4 shrink-0 gap-0.5 rounded-sm px-1 py-0 leading-4 tabular-nums",
            errors ? "text-red-primary hover:text-red-primary" : "text-yellow-primary hover:text-yellow-primary",
          )}
          onPointerDown={stop}
          onDoubleClick={stop}
        >
          <TriangleAlert className="size-[11px]" aria-hidden="true" />
          <span>{violations.length}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        aria-label={`Findings in ${title}`}
        align="start"
        padding="none"
        className="max-h-96"
        // The list is portalled, but React still bubbles its events to the
        // frame, which would hover, descend into or open menus on its layers.
        onPointerDown={stop}
        onPointerMove={stop}
        onDoubleClick={stop}
        onContextMenu={stop}
        onDragOver={stop}
        onDrop={stop}
      >
        <DesignFrameLintList violations={violations} onSelectLayer={onSelectLayer} />
      </PopoverContent>
    </Popover>
  );
}

export function DesignFrameLintList({ violations, onSelectLayer }: {
  violations: readonly DesignLintViolationWire[];
  onSelectLayer: (oid: string) => void;
}) {
  const groups = groupDesignLintViolations(violations);
  return (
    <div data-design-frame-lint-list="" className="flex flex-col py-1">
      {groups.map((group) => {
        const rows = violations
          .filter((violation) => violation.ruleId === group.ruleId)
          .sort((left, right) => left.line - right.line || left.column - right.column);
        const hidden = rows.length - ROWS_PER_RULE;
        return (
          <section key={group.ruleId} data-design-frame-lint-group={group.ruleId} className="flex flex-col">
            <h3 className="text-3xxs text-muted-fg flex items-center justify-between px-3 pt-2 pb-1 font-medium">
              <span>{group.label}</span>
              <span className="tabular-nums">{group.count}</span>
            </h3>
            {rows.slice(0, ROWS_PER_RULE).map((violation, index) => {
              const content = (
                <>
                  <span className="min-w-0 flex-1 break-words">{violation.message}</span>
                  <span className="text-muted-fg shrink-0 tabular-nums">Line {violation.line}</span>
                </>
              );
              const className = cn(
                "text-2xxs flex w-full items-start gap-2 px-3 py-1 text-left leading-4",
                violation.severity === "error" ? "text-red-fg" : "text-fg2",
              );
              const oid = violation.oid;
              return oid ? (
                <Button
                  key={`${violation.line}:${violation.column}:${index}`}
                  type="button"
                  variant="ghost"
                  data-design-frame-lint-finding=""
                  className={cn(className, "hover:bg-bg3-hover h-auto justify-start rounded-none border-0 font-normal whitespace-normal")}
                  onClick={() => onSelectLayer(oid)}
                >
                  {content}
                </Button>
              ) : (
                <div key={`${violation.line}:${violation.column}:${index}`} data-design-frame-lint-finding="" className={className}>
                  {content}
                </div>
              );
            })}
            {hidden > 0 ? <p className="text-3xxs text-muted-fg px-3 py-1">{hidden} more</p> : null}
          </section>
        );
      })}
    </div>
  );
}
