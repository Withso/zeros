// ──────────────────────────────────────────────────────────
// AgentModelMenu — the unified agent + model dropdown
// ──────────────────────────────────────────────────────────
//
// One dropdown for BOTH the chat composer's ModelPill and the new-workspace
// dispatcher's picker. Layout:
//
//   ┌──────┬──────────────────────────────────┐
//   │ [C]  │  🔍 Search models…               │
//   │ [O]  │  Opus 4.8  ✓        ★   ⌘1  │
//   │ [▢]  │  Fable 5            ☆   ⌘2  │
//   │      │  …                               │
//   └──────┴──────────────────────────────────┘
//
//   - Left rail: one brand-colored logo per runnable agent; the ★ favorites tab
//     was
//     removed). The rail tab that opens is the CURRENT chat's agent; the
//     current model carries the ✓. Rows are a single line — just the model
//     name (no agent subtitle, no NEW badge), with the ★ before the
//     trailing ⌘N hint.
//   - Universal search: the search box auto-focuses
//     on open, and the moment the query is non-empty it searches ALL
//     agents' models — the rail hides entirely and results span the full
//     popover width. Clearing the query restores the rail + active tab.
//   - ★ on a row stars it as that agent's ONE favorite (radio semantics).
//   - Shortcuts while open: ←/→ arrows switch the rail tab (→ next agent,
//     ← previous, wrapping; only while the search box is empty — a live
//     query hides the rail and the arrows revert to caret movement).
//     ⌘1…⌘9 picks the Nth visible model. Plain digits ALWAYS type into
//     the search; using plain digits for rail switching would consume numeric
//     search prefixes such as the leading "1" in "1M".
//   - Picking a model under a DIFFERENT agent emits the full selection —
//     the host decides what an agent switch means (the dispatcher swaps the
//     pending selection; the chat composer moves the chat to a tab bound to
//     that agent).
//   - `redirectCrossAgent`: once a chat has its first
//     prompt it IS that agent's session — other agents' models then carry a
//     ↗ after the name, meaning "opens a NEW chat tab on that agent+model".
//     A fresh chat (nothing sent) and the dispatcher switch freely, no ↗.
//
// Pre-session, `modelsForAgent(agentId, null)` returns the curated catalog,
// which is exactly the stable list the picker shows.
// ──────────────────────────────────────────────────────────

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, Check, Star } from "lucide-react";

import { cn } from "../../shared/ui/cn";
import { Kbd, Tooltip } from "@/renderer/shared/ui/primitives";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../shared/ui/primitives/popover";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "../../shared/ui/primitives/command";
import { AgentIcon } from "./agent-icon";
import {
  agentFamily,
  displayModelLabel,
  modelsForAgent,
  type ModelOption,
} from "./model-catalog";
import {
  effectiveFavoriteModel,
  getFavoriteModel,
  useFavoritesVersion,
} from "./model-favorites";
import { starFavoriteModel } from "./new-chat-defaults";
import { claimShortcutPriority } from "./shortcut-priority";
import { useAgentsSnapshot } from "./agents-cache";
import { useEnabledAgents } from "./enabled-agents";
import { isRunnableAgent } from "./agent-runnable";
import type { BridgeRegistryAgent } from "../../platform/bridge/messages";

/** A resolved agent + model choice. `model` is always concrete here — a row
 *  IS a model. */
export interface AgentModelSelection {
  agentId: string;
  agentName: string;
  model: string | null;
}

/** Stable rail-tab order for keyboard and pointer traversal:
 *  1 Claude · 2 Codex (ChatGPT) · 3 Cursor. Unknown families sort after. */
const FAMILY_ORDER: Record<string, number> = { claude: 0, codex: 1, cursor: 2 };

interface AgentGroup {
  agent: BridgeRegistryAgent;
  family: string;
  models: ModelOption[];
}

/** One flattened, searchable row (family tabs list one agent's models; the
 *  favorites tab lists each agent's effective favorite). */
interface Row {
  agent: BridgeRegistryAgent;
  family: string;
  model: ModelOption;
}

export function AgentModelMenu({
  agents: agentsProp,
  value,
  onSelect,
  open,
  onOpenChange,
  triggerTooltip = "Change model",
  redirectCrossAgent = false,
  children,
}: {
  /** Registry snapshot override (the dispatcher passes its own). When
   *  omitted, the shared agents cache is used (the chat composer). */
  agents?: BridgeRegistryAgent[] | null;
  /** The current agent + model (drives the opening rail tab + the ✓).
   *  `model: null` resolves to the agent's effective favorite. */
  value: { agentId: string | null; model: string | null } | null;
  onSelect: (next: AgentModelSelection) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Tooltip label on the trigger (empty ⇒ no tooltip). */
  triggerTooltip?: string;
  /** When true (a chat whose session already started), models under a
   *  DIFFERENT agent than the current one show a ↗ after the name —
   *  picking one opens a new chat tab instead of switching in place. */
  redirectCrossAgent?: boolean;
  /** The trigger element (rendered via PopoverTrigger asChild). */
  children: React.ReactNode;
}) {
  const snapshot = useAgentsSnapshot();
  const { isEnabled } = useEnabledAgents();
  // Re-render on any ★ change (this menu reads favorites across families,
  // which a per-family hook can't cover).
  useFavoritesVersion();

  const registry = agentsProp !== undefined ? agentsProp : snapshot;

  // Runnable, enabled agents with a curated catalog, in rail order. When the
  // registry hasn't loaded yet, degrade to the CURRENT agent alone (from
  // `value`) so the menu still lists its family's models pre-cache.
  const groups = useMemo<AgentGroup[]>(() => {
    const fromRegistry = (registry ?? [])
      .filter((a) => isEnabled(a.id, a.beta) && isRunnableAgent(a))
      .map((agent) => ({
        agent,
        family: agentFamily(agent.id),
        models: modelsForAgent(agent.id, null),
      }))
      .filter((g) => g.family !== "" && g.models.length > 0)
      .sort(
        (a, b) => (FAMILY_ORDER[a.family] ?? 9) - (FAMILY_ORDER[b.family] ?? 9),
      );
    if (fromRegistry.length > 0) return fromRegistry;
    if (value?.agentId) {
      const family = agentFamily(value.agentId);
      const models = modelsForAgent(value.agentId, null);
      if (family && models.length > 0) {
        return [
          {
            agent: { id: value.agentId, name: "" } as BridgeRegistryAgent,
            family,
            models,
          },
        ];
      }
    }
    return [];
  }, [registry, isEnabled, value?.agentId]);

  const currentFamily = agentFamily(value?.agentId ?? null);

  // Active rail tab + search — reset on every OPEN so the menu lands on the
  // chat's current agent with a clean query. The tab effect also keys on
  // the group count so a menu opened BEFORE the registry snapshot loads
  // snaps onto the right tab the moment the rails appear; the user hasn't
  // interacted yet in that window, so the snap can't fight a manual pick.
  const [tab, setTab] = useState<string>("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    if (open) setSearch("");
  }, [open]);
  useEffect(() => {
    if (!open) return;
    setTab(
      groups.some((g) => g.family === currentFamily)
        ? currentFamily
        : (groups[0]?.family ?? ""),
    );
    // Deliberately NOT keyed on the groups array identity (it's a fresh map
    // every render) — only on how many rails exist + which family is current.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, groups.length, currentFamily]);

  // True while the query is non-empty — UNIVERSAL SEARCH mode: the rail
  // hides and the results cover every agent's models, not just the active
  // tab's.
  const searching = search.trim().length > 0;

  // Row-highlight mode:
  //   "idle"    → show cmdk selection (used on open for the active model,
  //               and while searching to always mark the first result)
  //   "pointer" → pointer is INSIDE the list — cmdk selection follows the
  //               pointer and is visible (via hover + compound variant)
  //   "left"    → pointer has LEFT the list — suppress cmdk selection so
  //               nothing stays highlighted (the "sticky hover" fix)
  //   "kb"      → arrow keys are active — show cmdk selection
  // Transitions: open→idle, pointerEnter→pointer, pointerLeave→left,
  //   arrow→kb, pointerMove(while kb)→pointer.
  const [hlMode, setHlMode] = useState<"idle" | "pointer" | "left" | "kb">(
    "idle",
  );
  useEffect(() => {
    if (open) setHlMode("idle");
  }, [open]);
  // While searching, every keystroke changes the row set; keep the first
  // result highlighted ("idle" mode) so Enter always picks something.
  useEffect(() => {
    if (searching) setHlMode("idle");
  }, [searching, search]);

  const showCmdkSelection =
    hlMode === "idle" || hlMode === "pointer" || hlMode === "kb";

  // The rows the list shows: the active tab's models, or — while searching —
  // ALL agents' models filtered by the query (label / id / agent name).
  const rows = useMemo<Row[]>(() => {
    if (searching) {
      const q = search.trim().toLowerCase();
      return groups
        .flatMap((g) =>
          g.models.map((model) => ({
            agent: g.agent,
            family: g.family,
            model,
          })),
        )
        .filter(
          (r) =>
            r.model.label.toLowerCase().includes(q) ||
            r.model.value.toLowerCase().includes(q) ||
            r.agent.name.toLowerCase().includes(q),
        );
    }
    const g = groups.find((x) => x.family === tab);
    return g
      ? g.models.map((model) => ({ agent: g.agent, family: g.family, model }))
      : [];
  }, [groups, tab, search, searching]);

  // The row carrying the ✓: the current agent's current model (null model ⇒
  // its effective favorite, matching what the trigger pill displays).
  const activeModel =
    value?.model ??
    (value?.agentId ? effectiveFavoriteModel(value.agentId) : null);

  const pick = (row: Row) => {
    onSelect({
      agentId: row.agent.id,
      agentName: row.agent.name,
      model: row.model.value,
    });
    onOpenChange(false);
  };

  // Shortcuts while open — ←/→ switches the rail tab (only with an empty
  // query; digits ALWAYS type into the search); ⌘1…⌘9 picks the Nth
  // visible row.
  //
  // Registered as a WINDOW CAPTURE listener while open (not a React
  // onKeyDown on the popover wrapper) for two focus and priority reasons:
  //   1. PRIORITY — these shortcuts must beat every other keydown consumer
  //      (⌘1-9 / 1-9 are bound elsewhere in the app). Capture at window is
  //      the first stop on the propagation path, and stopPropagation there
  //      kills the event before any other handler — including window-level
  //      bubble listeners like the app hotkeys — can see it.
  //   2. SURVIVING REFOCUS — after ⌘-tabbing away and clicking back into
  //      the app, DOM focus can land outside the popover (body / another
  //      surface) while the menu is still open; a wrapper-scoped handler
  //      never receives those keydowns, a window listener always does.
  // State is read through refs so the listener binds once per open and
  // never goes stale.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const searchRef = useRef(search);
  searchRef.current = search;
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const pickRef = useRef(pick);
  pickRef.current = pick;
  useEffect(() => {
    if (!open) return;
    // Tell other global key handlers (question-card digit toggles, …) to
    // stand down while the menu is open — capture order alone can't give a
    // just-opened menu precedence over a longer-mounted listener.
    const release = claimShortcutPriority();
    const handler = (e: KeyboardEvent) => {
      const m = /^Digit([1-9])$/.exec(e.code);
      if (m && e.metaKey && !e.altKey && !e.ctrlKey) {
        // Swallow EVERY ⌘digit while the menu is open (⌘N has no typing
        // use), so a stray ⌘7 can't trigger an unrelated app shortcut
        // through the open menu; pick when the row exists.
        e.preventDefault();
        e.stopPropagation();
        const row = rowsRef.current[Number(m[1]) - 1];
        if (row) pickRef.current(row);
        return;
      }
      // ←/→: rail-tab switch (→ next agent, ← previous, wrapping), only
      // while the query is empty — a live query hides the rail and the
      // arrows must keep moving the caret in the search text. Bare digits
      // are deliberately NOT bound (2026-07-10 follow-up): they always
      // type into the search, so "1" can start a "1M" query.
      if (
        (e.key === "ArrowRight" || e.key === "ArrowLeft") &&
        !e.metaKey &&
        !e.altKey &&
        !e.ctrlKey &&
        searchRef.current === ""
      ) {
        const railGroups = groupsRef.current;
        if (railGroups.length < 2) return;
        const idx = railGroups.findIndex((g) => g.family === tabRef.current);
        const delta = e.key === "ArrowRight" ? 1 : -1;
        const next =
          railGroups[(idx + delta + railGroups.length) % railGroups.length];
        e.preventDefault();
        e.stopPropagation();
        setTab(next.family);
      }
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () => {
      window.removeEventListener("keydown", handler, { capture: true });
      release();
    };
  }, [open]);

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Tooltip label={triggerTooltip}>
        <PopoverTrigger asChild>{children}</PopoverTrigger>
      </Tooltip>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        className="w-[320px] p-0"
        // A ⌘N pick closes the menu with KEYBOARD modality; Radix's default
        // close-time focus restore would then paint a :focus-visible ring on
        // the trigger pill. Skip the restore so keyboard flow resumes in the
        // composer without an unrelated focus ring.
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <div className="flex">
          {/* ── Left rail: one logo per agent (hidden while a query is live
              — universal search takes the full popover width). ── */}
          {!searching && (
            <div
              className="border-border2 flex w-11 shrink-0 flex-col items-center gap-1 border-r py-2"
              role="tablist"
              aria-label="Agents"
            >
              {groups.map((g) => (
                <RailButton
                  key={g.agent.id}
                  active={tab === g.family}
                  label={`${g.agent.name || g.family} — switch with ← →`}
                  onSelect={() => setTab(g.family)}
                >
                  {/* Keep provider marks in their documented brand colors and
                      at the same 16px size as every logo in this dropdown. */}
                  <AgentIcon
                    agentId={g.agent.id}
                    iconUrl={g.agent.icon ?? null}
                    size={16}
                  />
                </RailButton>
              ))}
            </div>
          )}
          {/* ── Right pane: search + model rows. The search underline is the
              CommandInput's border-b — now --border2 in the primitive itself. ── */}
          <Command
            shouldFilter={false}
            className="min-w-0 flex-1 bg-transparent"
            // The active model's cmdk value — cmdk auto-scrolls to and
            // selects this row on mount, giving the "open on current model"
            // highlight. For search mode the rows change and cmdk defaults
            // to the first item, which is exactly what we want.
            defaultValue={
              value?.agentId && activeModel
                ? `${value.agentId}:${activeModel}`
                : undefined
            }
            onKeyDown={(e) => {
              if (/^Arrow(Down|Up)$|^(Home|End)$/.test(e.key)) {
                setHlMode("kb");
              }
            }}
          >
            <CommandInput
              value={search}
              onValueChange={setSearch}
              placeholder="Search models…"
            />
            <CommandList
              className="max-h-[340px]"
              onPointerEnter={() => setHlMode("pointer")}
              onPointerLeave={() => setHlMode("left")}
              onPointerMove={() => {
                if (hlMode === "kb") setHlMode("pointer");
              }}
            >
              <CommandEmpty>No models found.</CommandEmpty>
              {rows.map((row, i) => {
                const isActive =
                  currentFamily === row.family &&
                  activeModel === row.model.value;
                const isFav =
                  effectiveFavoriteModel(row.agent.id) === row.model.value;
                // ↗ — this chat's session already belongs to another agent;
                // picking this model opens a NEW chat tab on it.
                const redirects =
                  redirectCrossAgent && row.family !== currentFamily;
                return (
                  <CommandItem
                    // Scope by agent so families sharing a value stay distinct.
                    key={`${row.agent.id}:${row.model.value}`}
                    value={`${row.agent.id}:${row.model.value}`}
                    className={cn(
                      "group/mi mx-1 gap-2 py-1.5 first:mt-1 last:mb-1",
                      // Highlight mode (see hlMode above). cmdk marks the
                      // hovered row as "selected" too, so the compound
                      // variant is needed for pointer highlighting. When
                      // selection is suppressed ("left" mode) only the
                      // transparent override applies — hover clears itself.
                      !showCmdkSelection &&
                        "data-[selected=true]:bg-transparent",
                      showCmdkSelection &&
                        hlMode === "pointer" &&
                        "data-[selected=true]:hover:bg-bg3-hover",
                    )}
                    onSelect={() => pick(row)}
                  >
                    {/* Single-line row: just the model name, with no agent
                        subtitle or NEW badge. While
                        SEARCHING the rows span every agent and the rail is
                        hidden, so each row leads with its agent's 16px brand
                        logo to keep the results attributable. */}
                    <span className="flex min-w-0 flex-1 items-center gap-2">
                      {searching && (
                        <AgentIcon
                          agentId={row.agent.id}
                          iconUrl={row.agent.icon ?? null}
                          size={16}
                          className="shrink-0"
                        />
                      )}
                      <span className="truncate text-xs">
                        {displayModelLabel(row.agent.id, row.model.label)}
                      </span>
                      {redirects && (
                        <ArrowUpRight
                          className="text-fg2 size-3.5 shrink-0"
                          aria-label="Opens a new chat with this agent"
                        />
                      )}
                    </span>
                    {/* Trailing cluster — ✓ (active model), then ★, with the
                        ⌘N hint last. The tick sits immediately left of the star,
                        not after the name. The ★ is this
                        agent's ONE favorite (the model its new chats open on).
                        Radio semantics: starring moves the star; re-clicking a
                        user star reverts to the catalog fallback.
                        stopPropagation so it never selects the row. */}
                    {isActive && (
                      <Check className="text-fg1 size-3.5 shrink-0" />
                    )}
                    <Tooltip label={isFav ? "Default model" : "Set as default"}>
                      <button
                        type="button"
                        aria-label={
                          isFav
                            ? "Favorite model (new chats open on it)"
                            : "Favorite — make this the model new chats open on"
                        }
                        onMouseDown={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                        }}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          const userStar = getFavoriteModel(row.agent.id);
                          starFavoriteModel(
                            row.agent.id,
                            userStar === row.model.value
                              ? null
                              : row.model.value,
                          );
                        }}
                        className={cn(
                          "shrink-0 rounded-sm p-0.5 transition-opacity",
                          isFav
                            ? "opacity-100"
                            : "opacity-0 group-hover/mi:opacity-100 focus-visible:opacity-100",
                        )}
                      >
                        <Star
                          className={cn(
                            "size-3.5",
                            isFav ? "text-fg2 fill-current" : "text-fg2",
                          )}
                        />
                      </button>
                    </Tooltip>
                    {i < 9 && <Kbd aria-hidden>⌘{i + 1}</Kbd>}
                  </CommandItem>
                );
              })}
            </CommandList>
          </Command>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** One rail tab — a 32px icon button with the selected state painted as the
 *  popover row hover (bg3-hover) plus a right accent bar sitting on the
 *  rail/model-list divider border.
 *
 *  tabIndex={-1} + no focus outline: the rail is a pointer / digit-shortcut
 *  target, never a Tab stop. This also keeps Radix's open-time FocusScope
 *  off the rail — with the buttons unfocusable, the first tabbable in the
 *  popover is the SEARCH INPUT, so focus lands there on open instead of
 *  painting a :focus-visible ring on the first logo when a shortcut key is
 *  pressed. */
function RailButton({
  active,
  label,
  onSelect,
  children,
}: {
  active: boolean;
  label: string;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip label={label} side="right">
      <button
        type="button"
        role="tab"
        aria-selected={active}
        tabIndex={-1}
        // Switching agents must NOT blur the search — the whole menu is driven
        // from the always-focused search box (open-focus lands here because the
        // rail is tabIndex={-1}; ←/→ and ↓/↑ keep focus on the input). Clicking
        // a <button> normally focuses it, so preventDefault on mousedown stops
        // the focus move while letting onClick still fire. Mirrors the ★ button.
        onMouseDown={(e) => e.preventDefault()}
        onClick={onSelect}
        className={cn(
          "text-fg2 relative flex size-8 shrink-0 items-center justify-center rounded-sm transition-[background-color,color] duration-120 ease-out outline-none",
          active
            ? "bg-bg3-hover text-fg1"
            : "hover:bg-bg3-hover hover:text-fg1",
        )}
      >
        {active && (
          <span
            className="bg-highlighted-bright absolute -right-1.5 h-4 w-0.5 rounded-full"
            aria-hidden
          />
        )}
        {children}
      </button>
    </Tooltip>
  );
}
