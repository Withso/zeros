// ──────────────────────────────────────────────────────────
// SlashCommandPicker — autocomplete for agent `available_commands`
// ──────────────────────────────────────────────────────────
//
// Slash commands are advertised by the agent session protocol
// `available_commands_update` notifications and live on
// `session.availableCommands`. Typing "/" at the start of
// a prompt opens this picker; selecting inserts "/<name> "
// and the user continues typing args (or hits Enter).
//
// The command itself is just text — the agent is responsible
// for recognising the "/" prefix. We don't extend the protocol;
// we just make the catalogue discoverable.
// ──────────────────────────────────────────────────────────

import React, { useEffect, useRef } from "react";
import type { AvailableCommand } from "../../platform/bridge/agent-events";
import { slashCommandKind } from "../../platform/bridge/agent-events";
import { matchesSlashTab, type SlashTab } from "./composer-editor/suggestion";
import { Button } from "../../shared/ui";

// NOTE: the ranked filter (filterSlashCommands) lives in
// slash-command-filter.ts — exporting plain functions from this component
// module broke Vite React Fast Refresh (full reload on every edit, which
// visibly killed the open picker in dev). Keep this file components-only.

// ──────────────────────────────────────────────────────────
// Picker component
// ──────────────────────────────────────────────────────────

interface SlashCommandPickerProps {
  /** The full query-filtered list (ALL kinds). The active tab narrows this
   *  further for display + keyboard nav. */
  commands: AvailableCommand[];
  /** Agent id — used to tag terminal-kind commands with an "(opens terminal)"
   *  hint so the picker tells the user the command runs in a terminal. */
  agentId?: string | null;
  /** Active category tab. */
  slashTab: SlashTab;
  /** Switch tabs on click (keyboard Left/Right is handled in the store). */
  onTab: (tab: SlashTab) => void;
  /** Index INTO THE VISIBLE (tab-filtered) list. */
  highlightIndex: number;
  onHover: (index: number) => void;
  onPick: (command: AvailableCommand) => void;
}

const SLASH_TABS: { id: SlashTab; label: string }[] = [
  { id: "all", label: "All" },
  { id: "commands", label: "Commands" },
  { id: "skills", label: "Skills" },
];

export function SlashCommandPicker({
  commands,
  agentId,
  slashTab,
  onTab,
  highlightIndex,
  onHover,
  onPick,
}: SlashCommandPickerProps) {
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the active item scrolled into view as arrow keys move the cursor.
  useEffect(() => {
    const node = listRef.current?.children[highlightIndex] as
      | HTMLElement
      | undefined;
    if (node) node.scrollIntoView({ block: "nearest" });
  }, [highlightIndex]);

  // Slash picker — popover that opens ABOVE the composer textarea, anchored
  // to the composer card (position: relative) so its width matches the card,
  // with a bg1 background.
  const menuWrap =
    "absolute inset-x-0 bottom-[calc(100%+6px)] z-[25] overflow-hidden rounded-lg border border-border1 bg-bg1 shadow-lg";

  // Per-tab counts off the query-filtered set, so each tab shows how many of
  // its kind match what the user typed. Items with no `kind` count as commands.
  const counts: Record<SlashTab, number> = {
    all: commands.length,
    commands: commands.filter((c) => (c.kind ?? "command") === "command").length,
    skills: commands.filter((c) => c.kind === "skill").length,
  };

  // The visible list for the active tab — must match the store's slashVisible()
  // so highlightIndex (kept by the store) lines up with what's rendered.
  const visible = commands.filter((c) => matchesSlashTab(c, slashTab));

  // Plain compact buttons (NOT the <Button> component, which can't size below
  // its h-9 base). The header is a FIXED 36px tall (h-9; border-box folds in
  // the border-b) with the tab chips vertically centered.
  const tabBar = (
    <div className="flex h-9 items-center gap-1 border-b border-border1 px-1.5">
      {SLASH_TABS.map((t) => {
        const active = t.id === slashTab;
        return (
          <button
            key={t.id}
            type="button"
            // mousedown beats the textarea blur (same as the rows below).
            onMouseDown={(e) => {
              e.preventDefault();
              onTab(t.id);
            }}
            className={`flex cursor-pointer items-center gap-1 rounded-sm px-2 py-1.5 text-xs leading-none transition-colors duration-150 ease-out ${
              active
                ? "bg-bg1-hover text-fg1"
                : "text-fg2 hover:bg-bg1-hover hover:text-fg1"
            }`}
          >
            <span>{t.label}</span>
            <span className="text-fg3">{counts[t.id]}</span>
          </button>
        );
      })}
    </div>
  );

  return (
    <div className={menuWrap}>
      {tabBar}
      {visible.length === 0 ? (
        <div className="p-3 text-xs text-fg2">
          {slashTab === "skills" ? "No skills match." : "No commands match."}
        </div>
      ) : (
        <div ref={listRef} className="max-h-[220px] overflow-y-auto">
          {visible.map((cmd, i) => {
            const active = i === highlightIndex;
            // Tell the user a command opens a terminal (Claude /mcp, /login, …).
            // Appended dynamically by kind so it covers both curated built-ins
            // and the SDK's discovered commands without baking it into the text.
            const isTerminal = slashCommandKind(agentId, cmd.name) === "terminal";
            const description = isTerminal
              ? `${cmd.description ? `${cmd.description} ` : ""}(opens terminal)`
              : cmd.description;
            const isSkill = cmd.kind === "skill";
            return (
              <Button
                key={cmd.name}
                variant="ghost"
                type="button"
                onMouseEnter={() => onHover(i)}
                onMouseDown={(e) => {
                  // mousedown beats textarea blur.
                  e.preventDefault();
                  onPick(cmd);
                }}
                className={`flex w-full cursor-pointer items-center gap-2 border-0 bg-transparent px-3 py-1.5 text-left text-fg1 transition-[background] duration-150 ease-out hover:bg-bg1-hover ${
                  active ? "!bg-bg1-hover" : ""
                }`}
              >
                {/* Text "/" marker in place of an icon because the lucide Slash
                    glyph reads poorly. The command name drops its own
                    leading "/" since this marker already carries it. */}
                <span
                  className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-sm leading-none text-fg2"
                  aria-hidden="true"
                >
                  /
                </span>
                {/* One line: name then the description inline. */}
                <div className="flex min-w-0 flex-1 items-baseline gap-2">
                  <span className="shrink-0 text-xs text-fg1">{cmd.name}</span>
                  {description && (
                    <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-xs text-fg2">
                      {description}
                    </span>
                  )}
                </div>
                {cmd.input && (
                  <span className="shrink-0 text-xs text-fg3">
                    takes input
                  </span>
                )}
                {/* Skill badge — bordered bg1 chip at the row's end so the user
                    can tell a skill from a command at a glance, mirroring the
                    "takes input" affordance. */}
                {isSkill && (
                  <span className="shrink-0 rounded-sm border border-border1 bg-bg1 px-1.5 py-0.5 text-xxs leading-none text-fg2">
                    skill
                  </span>
                )}
              </Button>
            );
          })}
        </div>
      )}
    </div>
  );
}
