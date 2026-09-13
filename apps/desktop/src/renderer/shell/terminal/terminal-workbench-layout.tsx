import { Fragment, useRef } from "react";
import { ListTree, PanelBottom, Plus, Settings2, X } from "lucide-react";
import { Button, Separator, Tooltip } from "../../shared/ui/primitives";
import { cn } from "../../shared/ui/cn";
import { DynamicIcon } from "../../shared/ui/icon-registry";
import { RunWave } from "../../shared/ui/loading";
import { type WorkbenchTab } from "../workbench/tab-model";
import {
  WORKBENCH_TITLE_ACTION_CLS,
  WORKBENCH_TITLE_CHIP_CLS,
} from "../workbench/tab-chrome";
import { RunSessionButtons } from "./run-session-buttons";
import { useFilesSidebarFraction } from "../workbench/tabs/files-sidebar-width";
import { useSidebarResizeDrag } from "../workbench/tabs/use-sidebar-drag";
import { useResizeHint } from "../use-resize-hint";

export interface TerminalNavigationEntry {
  id: string;
  title: string;
  kind: "setup" | "run" | "terminal";
  runActionId?: string;
  previewUrl?: string | null;
  icon: string;
  exited?: boolean;
  running?: boolean;
  dot?: "running" | "passed" | "failed" | "stopped" | null;
  docked?: boolean;
  closable?: boolean;
}

export function TerminalWorkbenchLayout({
  tab,
  entries,
  onSelect,
  onClose,
  onAdd,
  onConfigure,
  onConfigureIntent,
  onRun,
  onRunSetup,
  setupRunDisabled,
  onStop,
  onOpenPreview,
  onDock,
  onToggleSidebar,
  bodyRef,
}: {
  tab: WorkbenchTab | null;
  entries: TerminalNavigationEntry[];
  onSelect(id: string): void;
  onClose(id: string): void;
  onAdd(): void;
  onConfigure(): void;
  onConfigureIntent(): void;
  onRun(actionId: string): void;
  onRunSetup(): void;
  setupRunDisabled: boolean;
  onStop(actionId: string): void;
  onOpenPreview(actionId: string): void;
  onDock(): void;
  onToggleSidebar(): void;
  bodyRef(node: HTMLDivElement | null): void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sidebarRef = useRef<HTMLDivElement | null>(null);
  const fraction = useFilesSidebarFraction();
  const onResize = useSidebarResizeDrag(containerRef, sidebarRef, "right");
  const { hintHandlers, hint } = useResizeHint("Drag to resize");
  const sidebarVisible = tab?.terminalSidebarVisible !== false;
  const activeEntry = entries.find((entry) => entry.id === tab?.terminalId);
  const firstShell = entries.findIndex((entry) => entry.kind === "terminal");
  const shellHeading = (
    <>
      {entries.length > 0 && (
        <Separator
          decorative={false}
          aria-label="Shell terminals"
          className="mt-1"
        />
      )}
      <div
        className="flex h-9 shrink-0 items-center justify-between px-2"
        data-terminal-shell-heading=""
      >
        <span className="text-fg2 text-xs font-medium">Terminals</span>
        <Tooltip label="New terminal">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="New terminal"
            onClick={onAdd}
          >
            <Plus className="text-fg2 size-3.5" />
          </Button>
        </Tooltip>
      </div>
    </>
  );
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      data-terminal-workbench=""
    >
      <div
        className="border-border1 @container/terminal-header flex h-9 shrink-0 items-center justify-between gap-2 border-b px-2"
        data-terminal-header=""
      >
        <div
          className="flex min-w-0 items-center gap-1"
          data-terminal-title-actions=""
        >
          <Tooltip label={tab?.title ?? "Terminal"}>
            <div className={WORKBENCH_TITLE_CHIP_CLS}>
              <span className="text-fg1 min-w-0 truncate text-xs font-medium">
                {tab?.title ?? "Terminal"}
              </span>
            </div>
          </Tooltip>
          {activeEntry?.running && activeEntry.runActionId && (
            <RunSessionButtons
              title={activeEntry.title}
              previewUrl={activeEntry.previewUrl}
              showLabels
              onOpenPreview={() => onOpenPreview(activeEntry.runActionId!)}
              onStop={() => onStop(activeEntry.runActionId!)}
            />
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Tooltip label="Move terminal to bottom panel">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Move terminal to bottom panel"
              onClick={onDock}
              className={WORKBENCH_TITLE_ACTION_CLS}
            >
              <PanelBottom className="text-fg2 size-3.5" />
            </Button>
          </Tooltip>
          <Tooltip label="Repository environment settings">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Repository environment settings"
              onClick={onConfigure}
              onPointerEnter={onConfigureIntent}
              onFocus={onConfigureIntent}
            >
              <Settings2 className="text-fg2 size-3.5" />
            </Button>
          </Tooltip>
          <Tooltip
            label={
              sidebarVisible ? "Hide terminal sidebar" : "Show terminal sidebar"
            }
          >
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={
                sidebarVisible
                  ? "Hide terminal sidebar"
                  : "Show terminal sidebar"
              }
              aria-pressed={sidebarVisible}
              onClick={onToggleSidebar}
              className={cn("shrink-0", sidebarVisible && "bg-bg2 text-fg1")}
            >
              <ListTree
                className={cn(
                  "size-3.5",
                  sidebarVisible ? "text-fg1" : "text-fg2",
                )}
              />
            </Button>
          </Tooltip>
        </div>
      </div>
      <div
        ref={containerRef}
        className="flex min-h-0 min-w-0 flex-1 overflow-hidden"
      >
        <div
          ref={bodyRef}
          className="relative min-h-0 min-w-0 flex-1 overflow-hidden"
        />
        {sidebarVisible && (
          <>
            <div className="bg-border1 relative w-px shrink-0">
              <div
                role="separator"
                aria-label="Resize terminal sidebar"
                aria-orientation="vertical"
                className="absolute -inset-x-[3px] inset-y-0 z-20 cursor-ew-resize select-none"
                onPointerDown={onResize}
                onMouseDown={(event) => event.preventDefault()}
                {...hintHandlers}
              />
              {hint}
            </div>
            <div
              ref={sidebarRef}
              className="flex min-h-0 max-w-[70%] min-w-[140px] shrink-0 flex-col overflow-hidden"
              style={{ width: `${fraction * 100}%` }}
            >
              <div
                role="tablist"
                aria-label="Terminal sessions"
                aria-orientation="vertical"
                className="min-h-0 flex-1 overflow-y-auto px-1 py-1"
                onKeyDown={(event) => {
                  if (
                    event.target instanceof HTMLElement &&
                    event.target.closest("button")?.getAttribute("role") !==
                      "tab"
                  )
                    return;
                  const buttons = Array.from(
                    event.currentTarget.querySelectorAll<HTMLButtonElement>(
                      'button[role="tab"]',
                    ),
                  );
                  const index = buttons.indexOf(
                    document.activeElement as HTMLButtonElement,
                  );
                  const next =
                    event.key === "ArrowDown"
                      ? (index + 1) % buttons.length
                      : event.key === "ArrowUp"
                        ? (index - 1 + buttons.length) % buttons.length
                        : event.key === "Home"
                          ? 0
                          : event.key === "End"
                            ? buttons.length - 1
                            : null;
                  if (next === null) return;
                  event.preventDefault();
                  buttons[next]?.focus();
                }}
              >
                {entries.map((entry, index) => (
                  <Fragment key={entry.id}>
                    {index === firstShell && shellHeading}
                    <div className="group/terminal relative mb-0.5">
                      <Button
                        variant="ghost"
                        size="sm"
                        role="tab"
                        aria-label={entry.title}
                        aria-selected={entry.id === tab?.terminalId}
                        onClick={() => onSelect(entry.id)}
                        className={cn(
                          "h-7 w-full justify-start gap-2 px-2 text-xs [&_svg]:size-3.5",
                          entry.id === tab?.terminalId && "bg-bg2 text-fg1",
                          entry.docked && "text-fg3 hover:text-fg3",
                          entry.closable && "pr-7",
                          (entry.docked || entry.dot) && "pr-9",
                          (entry.kind === "setup" || entry.runActionId) &&
                            "pr-12",
                          entry.runActionId && entry.running && "pr-16",
                        )}
                      >
                        {entry.running ? (
                          <RunWave
                            size={12}
                            className={cn(
                              "shrink-0",
                              entry.docked
                                ? "text-fg3"
                                : entry.id === tab?.terminalId
                                  ? "text-fg1"
                                  : "text-fg2",
                            )}
                          />
                        ) : (
                          <DynamicIcon
                            name={entry.icon}
                            className={cn(
                              "size-3.5 shrink-0",
                              entry.docked
                                ? "text-fg3"
                                : entry.id === tab?.terminalId
                                  ? "text-fg1"
                                  : "text-fg2",
                            )}
                          />
                        )}
                        <span className="min-w-0 truncate">
                          {entry.title}
                          {entry.exited ? " (exited)" : ""}
                        </span>
                        <span
                          className={cn(
                            "pointer-events-none absolute inset-y-0 right-1 flex items-center gap-1",
                            (entry.kind === "setup" ||
                              entry.runActionId ||
                              entry.closable) &&
                              "group-hover/terminal:opacity-0 group-has-[:focus-visible]/terminal:opacity-0",
                          )}
                        >
                          {entry.dot && (
                            <span
                              aria-hidden
                              className={cn(
                                "size-1.5 shrink-0 rounded-full",
                                entry.dot === "running" && "bg-yellow-primary",
                                entry.dot === "passed" && "bg-green-primary",
                                (entry.dot === "failed" ||
                                  entry.dot === "stopped") &&
                                  "bg-red-primary",
                              )}
                            />
                          )}
                          {entry.docked && (
                            <span className="flex w-6 shrink-0 items-center justify-center">
                              <PanelBottom
                                className="text-fg3 size-3.5 shrink-0"
                                data-terminal-dock-indicator=""
                                aria-label="In bottom panel"
                              />
                            </span>
                          )}
                        </span>
                      </Button>
                      {(entry.kind === "setup" || entry.runActionId) && (
                        <div
                          className="pointer-events-none absolute inset-y-0 right-1 flex items-center opacity-0 group-hover/terminal:pointer-events-auto group-hover/terminal:opacity-100 group-has-[:focus-visible]/terminal:pointer-events-auto group-has-[:focus-visible]/terminal:opacity-100"
                          data-terminal-row-actions=""
                        >
                          {entry.runActionId && entry.running ? (
                            <RunSessionButtons
                              title={entry.title}
                              previewUrl={entry.previewUrl}
                              onOpenPreview={() =>
                                onOpenPreview(entry.runActionId!)
                              }
                              onStop={() => onStop(entry.runActionId!)}
                            />
                          ) : (
                            <Tooltip
                              label={`Run ${entry.title}`}
                              // Setup is the first row; a top tooltip would
                              // cover the header's dock/settings controls.
                              side={entry.kind === "setup" ? "left" : "top"}
                            >
                              <Button
                                variant="ghost"
                                size="sm"
                                aria-label={`Run ${entry.title}`}
                                disabled={
                                  entry.kind === "setup" && setupRunDisabled
                                }
                                onClick={() => {
                                  if (entry.kind === "setup") onRunSetup();
                                  else if (entry.runActionId)
                                    onRun(entry.runActionId);
                                }}
                                className="text-blue-fg hover:text-blue-fg px-2 text-xs"
                              >
                                Run
                              </Button>
                            </Tooltip>
                          )}
                        </div>
                      )}
                      {entry.closable && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Close ${entry.title}`}
                          onClick={() => onClose(entry.id)}
                          className="pointer-events-none absolute top-0.5 right-1 opacity-0 group-hover/terminal:pointer-events-auto group-hover/terminal:opacity-100 group-has-[:focus-visible]/terminal:pointer-events-auto group-has-[:focus-visible]/terminal:opacity-100 [&_svg]:size-3.5"
                        >
                          <X className="text-fg2 size-3.5" />
                        </Button>
                      )}
                    </div>
                  </Fragment>
                ))}
                {firstShell < 0 && shellHeading}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
