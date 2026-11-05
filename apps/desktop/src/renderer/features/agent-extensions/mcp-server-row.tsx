import * as React from "react";
import { ChevronDown, Ellipsis } from "lucide-react";

import { cn } from "../../shared/ui/cn";
import { Badge } from "../../shared/ui/primitives/badge";
import { Button } from "../../shared/ui/primitives/button";
import { IconButton } from "../../shared/ui/primitives/icon-button";
import { Switch } from "../../shared/ui/primitives/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../shared/ui/primitives/dropdown-menu";

export interface McpRowMenuItem {
  label: string;
  onSelect: () => void;
  destructive?: boolean;
  disabled?: boolean;
}

/** One MCP server in a list card. A 48px transport column keeps every name on
 * one left edge; the name and one 12px hint follow. The trailing slot shows
 * status only when the server needs the person, its one action, the switch
 * and one ⋯ menu, all 24px. Connected, starting with the agent and disabled
 * are normal states and show nothing: the switch already says Disabled. */
export function McpServerRow({
  transport,
  name,
  hint,
  hintMono = false,
  dimmed = false,
  status,
  action,
  tools,
  toggle,
  menu,
  trailing,
  onOpen,
  children,
}: {
  transport: string;
  name: string;
  hint?: React.ReactNode;
  /** Endpoints and commands are literals: mono. Descriptions are not. */
  hintMono?: boolean;
  /** Inherited servers dim their name. */
  dimmed?: boolean;
  /** A Badge, only when the server needs the person. */
  status?: React.ReactNode;
  /** The row's one action: Connect, Retry or Cancel. */
  action?: React.ReactNode;
  /** The tool count that opens the tool list. */
  tools?: React.ReactNode;
  toggle?: {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
    disabled?: boolean;
  };
  menu?: { items: McpRowMenuItem[]; disabled?: boolean };
  /** Controls after the menu, for rows that have no menu (Override here). */
  trailing?: React.ReactNode;
  /** Opens the server: the name is also the way in, as Edit is in the menu. */
  onOpen?: { label: string; onClick: () => void; disabled?: boolean };
  /** The open tool list, under the server. */
  children?: React.ReactNode;
}) {
  const identity = (
    <>
      <span className="flex w-12 shrink-0">
        <Badge variant="outline" mono>
          {transport}
        </Badge>
      </span>
      <div className="flex min-w-0 flex-col gap-0.5 text-left">
        <span
          className={cn(
            "truncate text-xs leading-4.5 font-medium",
            dimmed ? "text-fg2" : "text-fg1",
          )}
        >
          {name}
        </span>
        {hint ? (
          <span
            className={cn(
              "text-fg3 truncate text-3xxs leading-4 font-normal",
              hintMono && "font-mono",
            )}
          >
            {hint}
          </span>
        ) : null}
      </div>
    </>
  );
  return (
    <div data-slot="mcp-server-row" className="flex min-w-0 flex-col">
      <div className="flex min-w-0 items-center justify-between gap-4">
        {onOpen ? (
          <Button
            variant="ghost"
            aria-label={onOpen.label}
            onClick={onOpen.onClick}
            disabled={onOpen.disabled}
            className="h-auto min-w-0 flex-1 justify-start gap-3 border-0 p-0 hover:bg-transparent"
          >
            {identity}
          </Button>
        ) : (
          <div className="flex min-w-0 items-center gap-3">{identity}</div>
        )}
        <div className="flex shrink-0 items-center gap-2">
          {status}
          {action}
          {tools}
          {toggle ? (
            <Switch
              checked={toggle.checked}
              onCheckedChange={toggle.onCheckedChange}
              disabled={toggle.disabled}
              aria-label={`Use ${name}`}
            />
          ) : null}
          {menu && menu.items.length > 0 ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton
                  size="compact"
                  label={`More actions for ${name}`}
                  disabled={menu.disabled}
                >
                  <Ellipsis />
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {menu.items.map((item) => (
                  <DropdownMenuItem
                    key={item.label}
                    variant={item.destructive ? "destructive" : "default"}
                    disabled={item.disabled}
                    onSelect={item.onSelect}
                  >
                    {item.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          {trailing}
        </div>
      </div>
      {children ? (
        // Under the name column: past the 48px transport column and its gap.
        <div className="mt-3 flex min-w-0 gap-3">
          <span aria-hidden className="w-12 shrink-0" />
          <div className="min-w-0 flex-1">{children}</div>
        </div>
      ) : null}
    </div>
  );
}

/** The tool count: a 24px Ghost that opens the tool list. */
export function McpToolCount({
  count,
  open,
  onToggle,
  disabled,
}: {
  count: number;
  open: boolean;
  onToggle: () => void;
  disabled?: boolean;
}) {
  return (
    <Button
      variant="ghost"
      size="compact"
      className="text-fg2"
      aria-expanded={open}
      onClick={onToggle}
      disabled={disabled}
    >
      {count} {count === 1 ? "tool" : "tools"}
      <ChevronDown
        aria-hidden
        className={cn(
          "transition-transform duration-150 ease-out",
          open && "rotate-180",
        )}
      />
    </Button>
  );
}

/** A server's tools, under its name: 32px sans rows, off tools in `fg3`, the
 * switches on the server switch's column. One inset rule, no nested box. */
export function McpToolList({
  server,
  tools,
  isOn,
  onToggle,
  disabled,
}: {
  server: string;
  tools: readonly string[];
  isOn: (tool: string) => boolean;
  onToggle: (tool: string, on: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div
      role="group"
      aria-label={`${server} tools`}
      // 32px clears the ⋯ menu and its gap, so each switch sits under the
      // server's.
      className="border-border1 flex min-w-0 flex-col border-t pt-1 pr-8"
    >
      {tools.map((tool) => {
        const on = isOn(tool);
        return (
          <div
            key={tool}
            className="flex h-8 min-w-0 items-center justify-between gap-4"
          >
            <span
              className={cn(
                "min-w-0 truncate text-xs leading-4.5",
                on ? "text-fg2" : "text-fg3",
              )}
            >
              {tool}
            </span>
            <Switch
              checked={on}
              onCheckedChange={(checked) => onToggle(tool, checked)}
              disabled={disabled}
              aria-label={`Use ${tool}`}
            />
          </div>
        );
      })}
    </div>
  );
}
