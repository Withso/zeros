// ──────────────────────────────────────────────────────────
// Terminal Agents — Settings → Terminal Agents tab
// ──────────────────────────────────────────────────────────
//
// The body of the Terminal Agents settings tab (gated behind the
// `terminalAgents` experimental flag). Configures how coding CLIs
// launch from the workbench terminal panel.
//
// Deliberately minimal. The launch command IS the agent's name (so
// tabs / the Default picker read "claude", "codex", "droid", …), and
// each agent exposes only three knobs — Launch command, Additional
// parameters, Auto-approve CLI flag. Built-ins are always shown
// (the protected core set carries logos; the rest are name-only).
// "+ Add agent" lets the user register any CLI by its
// launch command. No reset — fields are pre-filled defaults the user
// edits freely. Flat layout, shared design-system primitives.
//
// Storage + the launch resolver live in `./terminal-agents.ts`; this
// file is purely presentational (reads/writes via useTerminalAgents()).
// ──────────────────────────────────────────────────────────

import React, { useEffect, useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";

import { Button, Input } from "../../shared/ui";
import { Tooltip } from "@/renderer/shared/ui/primitives";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../shared/ui/primitives/select";
import { toast } from "../../shared/ui/primitives/elements";
import { cn } from "@/renderer/shared/ui/cn";
import { SettingsRow, SettingsField, SettingsActions } from "./settings-ui";
import { AgentIcon } from "../agent/agent-icon";
import {
  BUILTIN_TERMINAL_AGENTS,
  CORE_TERMINAL_AGENT_IDS,
  TERMINAL_AGENT_ORDER,
  useTerminalAgents,
  type TerminalAgent,
} from "./terminal-agents";

// Sentinel activeId for the "+ Add agent" draft (no real agent selected).
const NEW_AGENT = "__new__";
const ACTIVE_AGENT_KEY = "zeros:terminal-agents-active:v1";

function readActiveAgentId(): string {
  try {
    return localStorage.getItem(ACTIVE_AGENT_KEY) ?? "";
  } catch {
    return "";
  }
}

function persistActiveAgentId(id: string): void {
  try {
    if (id) localStorage.setItem(ACTIVE_AGENT_KEY, id);
    else localStorage.removeItem(ACTIVE_AGENT_KEY);
  } catch {
    /* best-effort preference */
  }
}

/** The agent's display label IS its launch command — "the launch command
 *  is the name of the agent". Falls back to name/id for safety. */
function labelOf(agent: TerminalAgent): string {
  return agent.launchCommand.trim() || agent.name || agent.id;
}

/** Blank draft for the "+ Add agent" flow. */
const BLANK_AGENT: TerminalAgent = {
  id: "",
  name: "",
  description: "",
  binary: "",
  launchCommand: "",
  promptTransport: "interactive",
  promptArgs: [],
  additionalArgs: [],
  autoApproveFlag: "",
  loginArgs: [],
  imported: false,
};

/** Derive a stable, unique id from a launch command (first token,
 *  slugified). Custom agents land outside TERMINAL_AGENT_ORDER so they
 *  append after the built-ins. */
function deriveAgentId(launchCommand: string, taken: Set<string>): string {
  const base =
    (launchCommand.trim().split(/\s+/)[0] || "agent")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "agent";
  let id = base;
  let n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  return id;
}

// ── Section root ─────────────────────────────────────────

export function TerminalAgentsSection() {
  const { agents, defaultId, removedIds, setDefault, upsert, remove } =
    useTerminalAgents();

  // Protected core agents are always shown; other built-ins remain until the
  // user removes them, and custom agents append after. Saved edits overlay the
  // built-in seed.
  // Finally de-dupe by launch command (the display name) so a leftover entry
  // colliding with a built-in never double-ups.
  const ordered = useMemo(() => {
    const saved = new Map(agents.map((a) => [a.id, a]));
    const removed = new Set(removedIds);
    const out: TerminalAgent[] = [];
    for (const seed of BUILTIN_TERMINAL_AGENTS) {
      if (!CORE_TERMINAL_AGENT_IDS.includes(seed.id) && removed.has(seed.id)) {
        continue;
      }
      out.push(saved.get(seed.id) ?? seed);
    }
    for (const a of agents) {
      if (!TERMINAL_AGENT_ORDER.includes(a.id)) out.push(a);
    }
    const seen = new Set<string>();
    return out.filter((a) => {
      const key = a.launchCommand.trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [agents, removedIds]);

  // Only real agent selections survive reload. The unsaved + Add agent draft
  // remains deliberately ephemeral and never replaces the last confirmed tab.
  const [requestedActiveId, setRequestedActiveId] =
    useState<string>(readActiveAgentId);
  const activeId =
    requestedActiveId === NEW_AGENT
      ? NEW_AGENT
      : ordered.some((agent) => agent.id === requestedActiveId)
        ? requestedActiveId
        : (ordered[0]?.id ?? "");
  const selectActiveId = (id: string) => {
    setRequestedActiveId(id);
    if (id !== NEW_AGENT) persistActiveAgentId(id);
  };

  const creating = activeId === NEW_AGENT;
  const active = creating
    ? null
    : (ordered.find((a) => a.id === activeId) ?? ordered[0] ?? null);

  const handleCreate = (draft: TerminalAgent) => {
    const cmd = draft.launchCommand.trim();
    if (!cmd) return;
    // No duplicate launch commands — the launch command IS the name.
    if (ordered.some((a) => a.launchCommand.trim() === cmd)) {
      toast.error(`An agent with launch command "${cmd}" already exists.`);
      return;
    }
    // Reserve built-in ids too so a custom never collides with one.
    const taken = new Set([
      ...ordered.map((a) => a.id),
      ...TERMINAL_AGENT_ORDER,
    ]);
    const id = deriveAgentId(cmd, taken);
    upsert({
      ...draft,
      id,
      name: cmd,
      binary: cmd.split(/\s+/)[0] || cmd,
      imported: false,
    });
    selectActiveId(id);
    toast.success(`${cmd} added.`);
  };

  const handleRemove = (agent: TerminalAgent) => {
    if (activeId === agent.id) {
      selectActiveId(ordered.find((item) => item.id !== agent.id)?.id ?? "");
    }
    remove(agent.id, agent.launchCommand);
    toast.success(`${labelOf(agent)} removed.`);
  };

  const handleSave = (next: TerminalAgent) => {
    upsert({
      ...next,
      name: next.launchCommand.trim() || next.name,
      imported: true,
    });
    toast.success(`${labelOf(next)} saved.`);
  };

  return (
    <section className="flex flex-col gap-6">
      <DefaultAgentRow
        agents={ordered}
        defaultId={defaultId}
        onChange={setDefault}
      />

      <TerminalAgentTabs
        agents={ordered}
        activeId={activeId}
        creating={creating}
        onSelect={selectActiveId}
        onAdd={() => selectActiveId(NEW_AGENT)}
      />

      {creating ? (
        <TerminalAgentCard
          key={NEW_AGENT}
          agent={BLANK_AGENT}
          mode="new"
          onCreate={handleCreate}
        />
      ) : (
        active && (
          <TerminalAgentCard
            key={active.id}
            agent={active}
            mode="edit"
            protectedAgent={CORE_TERMINAL_AGENT_IDS.includes(active.id)}
            onSave={handleSave}
            onRemove={() => handleRemove(active)}
          />
        )
      )}
    </section>
  );
}

// ── Default-agent picker ─────────────────────────────────

function DefaultAgentRow({
  agents,
  defaultId,
  onChange,
}: {
  agents: TerminalAgent[];
  defaultId: string | null;
  onChange(id: string | null): void;
}) {
  // Radix Select can't carry null, so model "no default" as a sentinel.
  const NONE = "__none__";
  return (
    <SettingsRow label="Default agent" hint="Agent for new terminal">
      <Select
        value={defaultId ?? NONE}
        onValueChange={(v) => onChange(v === NONE ? null : v)}
      >
        <SelectTrigger className="min-w-[200px]">
          <SelectValue placeholder="Pick an agent…" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>None</SelectItem>
          {agents.map((a) => (
            <SelectItem key={a.id} value={a.id}>
              {labelOf(a)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SettingsRow>
  );
}

// ── Tab strip ────────────────────────────────────────────

const TAB_CLS =
  "-mb-px inline-flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-none border-x-0 border-t-0 border-b-2 bg-transparent px-3 text-sm font-medium transition-colors duration-150 ease-out";

function TerminalAgentTabs({
  agents,
  activeId,
  creating,
  onSelect,
  onAdd,
}: {
  agents: TerminalAgent[];
  activeId: string;
  creating: boolean;
  onSelect(id: string): void;
  onAdd(): void;
}) {
  return (
    <div className="flex flex-row items-stretch">
      {/* The bottom border lives on the tab strip ONLY (flex-grows to fill the
          row), so the baseline never runs under the "+ Add agent" button. */}
      <div
        role="tablist"
        className="border-border1 flex min-w-0 flex-1 flex-row items-center gap-0.5 overflow-x-auto border-b [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {agents.map((agent) => {
          const isActive = !creating && activeId === agent.id;
          return (
            <button
              key={agent.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => onSelect(agent.id)}
              className={cn(
                TAB_CLS,
                isActive
                  ? "border-fg1 text-fg1"
                  : "text-fg2 hover:text-fg1 border-transparent",
              )}
            >
              {/* Logo only for agents that carry one; every other agent is
                  name-only. */}
              {agent.icon && (
                <AgentIcon
                  agentId={agent.id}
                  iconUrl={agent.icon}
                  size={14}
                  monochrome={!isActive}
                />
              )}
              <span>{labelOf(agent)}</span>
            </button>
          );
        })}
      </div>

      {/* "+ Add agent" sits OUTSIDE the bordered strip (no underline beneath
          it), pinned at the right end. New agents append at the end. */}
      <button
        type="button"
        onClick={onAdd}
        className={cn(
          "inline-flex h-9 shrink-0 cursor-pointer items-center gap-1.5 px-3 text-sm font-medium transition-colors duration-150 ease-out",
          creating ? "text-fg1" : "text-fg2 hover:text-fg1",
        )}
      >
        <Plus className="size-3.5" aria-hidden="true" />
        Add agent
      </button>
    </div>
  );
}

// ── Per-agent card (edit + new) ──────────────────────────

function TerminalAgentCard({
  agent,
  mode,
  protectedAgent = false,
  onSave,
  onCreate,
  onRemove,
}: {
  agent: TerminalAgent;
  mode: "edit" | "new";
  /** Protected core agent — launch command locked and not removable. */
  protectedAgent?: boolean;
  onSave?(next: TerminalAgent): void;
  onCreate?(draft: TerminalAgent): void;
  onRemove?(): void;
}) {
  // Local form state — committed on Save so partial edits don't poison
  // the catalog.
  const [draft, setDraft] = useState<TerminalAgent>(agent);
  useEffect(() => {
    setDraft(agent);
  }, [agent]);

  const isNew = mode === "new";
  const idBase = agent.id || "new";
  const launchOk = draft.launchCommand.trim().length > 0;
  const hasChanges = JSON.stringify(draft) !== JSON.stringify(agent);
  // Launch command is mandatory (it's the agent's name). New agents need it;
  // edits need it AND some change to enable Save.
  const canSave = isNew ? launchOk : launchOk && hasChanges;
  // Non-core agents (and customs) can be removed via the bin near Save.
  const showRemove = !isNew && !protectedAgent && !!onRemove;

  const handleSave = () => {
    if (isNew) onCreate?.(draft);
    else onSave?.(draft);
  };

  return (
    <div className="flex flex-col">
      <SettingsField label="Launch command" htmlFor={`launch-${idBase}`}>
        <Input
          id={`launch-${idBase}`}
          value={draft.launchCommand}
          onChange={(e) =>
            setDraft({ ...draft, launchCommand: e.target.value })
          }
          spellCheck={false}
          autoComplete="off"
          // Core agents launch under a fixed command — read-only.
          disabled={protectedAgent}
          className="font-mono text-xs"
          placeholder={agent.binary || "e.g. claude"}
        />
      </SettingsField>

      <SettingsField
        label="Additional parameters"
        htmlFor={`extra-args-${idBase}`}
      >
        <Input
          id={`extra-args-${idBase}`}
          value={draft.additionalArgs.join(" ")}
          onChange={(e) =>
            setDraft({ ...draft, additionalArgs: splitArgs(e.target.value) })
          }
          spellCheck={false}
          autoComplete="off"
          className="font-mono text-xs"
          placeholder="--model"
        />
      </SettingsField>

      <SettingsField
        label="Auto-approve CLI flag"
        htmlFor={`auto-approve-${idBase}`}
      >
        <Input
          id={`auto-approve-${idBase}`}
          value={draft.autoApproveFlag}
          onChange={(e) =>
            setDraft({ ...draft, autoApproveFlag: e.target.value })
          }
          spellCheck={false}
          autoComplete="off"
          className="font-mono text-xs"
          placeholder="--dangerously-skip-permissions"
        />
      </SettingsField>

      <SettingsActions>
        {showRemove && (
          <Tooltip label="Remove agent">
            <Button
              variant="ghost"
              size="sm"
              onClick={onRemove}
              className="text-fg2"
              aria-label="Remove agent"
            >
              <Trash2 className="size-4" aria-hidden="true" />
            </Button>
          </Tooltip>
        )}
        <Button size="sm" onClick={handleSave} disabled={!canSave}>
          {isNew ? "Add agent" : "Save changes"}
        </Button>
      </SettingsActions>
    </div>
  );
}

// ── Small helpers ────────────────────────────────────────

/** Split a space-separated arg string into tokens, dropping empties.
 *  Intentionally simple — no shell-quote awareness — so power users who
 *  need a literal space inside an arg fall back to launchCommand. */
function splitArgs(raw: string): string[] {
  return raw
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}
