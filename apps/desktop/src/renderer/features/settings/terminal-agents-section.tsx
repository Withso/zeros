
import React, { useEffect, useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";

import { Button, Input } from "../../shared/ui";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../shared/ui/primitives/select";
import { toast } from "../../shared/ui/primitives/elements";
import { Tabs, TabsList, TabsTrigger } from "../../shared/ui/primitives/tabs";
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

function labelOf(agent: TerminalAgent): string {
  return agent.launchCommand.trim() || agent.name || agent.id;
}

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


export function TerminalAgentsSection() {
  const { agents, defaultId, removedIds, setDefault, upsert, remove } =
    useTerminalAgents();

  // Seed built-ins first so stale custom entries with the same launch command cannot shadow them.
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

  // The Add agent draft must not replace the last persisted agent selection.
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
    if (ordered.some((a) => a.launchCommand.trim() === cmd)) {
      toast.error(`An agent with launch command "${cmd}" already exists.`);
      return;
    }
    // Reserve hidden built-in IDs so restoring one cannot replace a custom profile.
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
    <section className="flex flex-col gap-8">
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
        <SelectTrigger width="fixed">
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
    <Tabs value={creating ? "" : activeId} onValueChange={onSelect}>
      <div className="flex min-w-0 items-center gap-2">
        <TabsList
          aria-label="Terminal agents"
          className="max-w-full min-w-0 justify-start overflow-x-auto [scrollbar-width:none]"
        >
          {agents.map((agent) => {
            const isActive = !creating && activeId === agent.id;
            return (
              <TabsTrigger key={agent.id} value={agent.id} className="shrink-0">
                {agent.icon && (
                  <AgentIcon
                    agentId={agent.id}
                    iconUrl={agent.icon}
                    size={14}
                    monochrome={!isActive}
                  />
                )}
                <span>{labelOf(agent)}</span>
              </TabsTrigger>
            );
          })}
        </TabsList>
        <Button
          variant="ghost"
          size="compact"
          onClick={onAdd}
          className={cn("shrink-0", creating ? "text-fg1" : "text-fg2")}
        >
          <Plus aria-hidden="true" />
          Add agent
        </Button>
      </div>
    </Tabs>
  );
}


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
  // Keep partial launch edits out of the live catalog until Save.
  const [draft, setDraft] = useState<TerminalAgent>(agent);
  useEffect(() => {
    setDraft(agent);
  }, [agent]);

  const isNew = mode === "new";
  const idBase = agent.id || "new";
  const launchOk = draft.launchCommand.trim().length > 0;
  const hasChanges = JSON.stringify(draft) !== JSON.stringify(agent);
  const canSave = isNew ? launchOk : launchOk && hasChanges;
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
          <Button
            variant="ghost"
            size="sm"
            onClick={onRemove}
            className="text-fg2"
            aria-label="Remove agent"
          >
            <Trash2 className="size-4" aria-hidden="true" />
          </Button>
        )}
        <Button size="sm" onClick={handleSave} disabled={!canSave}>
          {isNew ? "Add agent" : "Save changes"}
        </Button>
      </SettingsActions>
    </div>
  );
}


// Extra arguments are split on whitespace, not parsed as shell syntax; use the launch command for quoted arguments.
function splitArgs(raw: string): string[] {
  return raw
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}
