// ──────────────────────────────────────────────────────────
// AgentModelMenu — the unified agent + model dropdown
// ──────────────────────────────────────────────────────────
//
// One dropdown for both the chat composer and new-workspace dispatcher.
// The opening surface edits the active model's reasoning/Fast configuration,
// then keeps an always-focused search above ONE collapsed selected-model row.
// Typing shows universal results inline. Hovering/focusing the selected row
// opens the full catalog in a collision-aware sidecar, grouped under a brand
// mark + agent title; there is no provider-logo rail. Rows show each exact
// model's remembered effort/Fast state, and one global star matches Settings'
// default identity.
//
// Universal search spans every connected agent. Picking another agent in a
// started chat redirects to a new chat; a fresh chat/dispatcher switches in
// place. See `redirectCrossAgent` below.
//   - Picking a model under a DIFFERENT agent emits the full selection —
//     the host decides what an agent switch means (the dispatcher swaps the
//     pending selection; the chat composer moves the chat to a tab bound to
//     that agent).
//   - `redirectCrossAgent`: once a chat has its first prompt it IS that agent's
//     session. Other-agent rows announce the new-chat action in their accessible
//     name without adding another glyph to the requested row anatomy. A fresh
//     chat (nothing sent) and the dispatcher switch freely.
//
// Pre-session, `modelsForAgent(agentId, null)` returns the stable curated rows
// that do not require account discovery. Account-qualified compatibility rows
// join only when the live provider marks them selectable.
// ──────────────────────────────────────────────────────────

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Check, ChevronRight, Star } from "lucide-react";

import { cn } from "../../shared/ui/cn";
import { Switch, Tooltip } from "@/renderer/shared/ui/primitives";
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
import {
  agentFamily,
  agentSupportsEffort,
  agentSupportsFast,
  displayModelLabel,
  effectiveEffort,
  effortLabel,
  effortLevelsFor,
  modelsForAgent,
  resolveModelOption,
  type ModelOption,
} from "./model-catalog";
import { effectiveFavoriteModel, useFavoritesVersion } from "./model-favorites";
import {
  rememberModelConfiguration,
  starFavoriteModel,
} from "./new-chat-defaults";
import {
  resolveModelConfiguration,
  useModelPreferencesVersion,
  type ModelConfiguration,
} from "./model-preferences";
import { claimShortcutPriority } from "./shortcut-priority";
import { AgentIcon } from "./agent-icon";
import { useAgentsSnapshot } from "./agents-cache";
import { useEnabledAgents } from "./enabled-agents";
import { isRunnableAgent } from "./agent-runnable";
import { pickDefaultAgent } from "../settings/default-agent";
import type { BridgeRegistryAgent } from "../../platform/bridge/messages";
import type { InitializeResponse } from "../../platform/bridge/agent-events";

/** A resolved agent + model choice. `model` is always concrete here — a row
 *  IS a model. */
export interface AgentModelSelection {
  agentId: string;
  agentName: string;
  model: string | null;
}

/** Stable catalog group order: Claude · Codex · Cursor. Unknowns follow. */
const FAMILY_ORDER: Record<string, number> = { claude: 0, codex: 1, cursor: 2 };
const FAMILY_TITLES: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
};
/** Section labels ("Reasoning", "Options", "Model", each agent group) share one
 *  12px muted line; 28px tall so they keep the control scale's rhythm. */
const MODEL_SECTION_HEADING = "text-fg2 flex h-7 items-center text-3xxs";
const MODEL_POPOVER_WIDTH = "w-[230px] max-w-[calc(100vw-1rem)]";
const MODEL_ROW_ACTION_VISIBILITY =
  "pointer-events-none opacity-0 group-hover/mi:pointer-events-auto group-hover/mi:opacity-100 group-focus-within/mi:pointer-events-auto group-focus-within/mi:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100";
const MODEL_ROW_HEIGHT = "h-[26px] py-1";
const MODEL_ITEM_STACK = "flex flex-col gap-px";
const MODEL_COMMAND_ITEM_STACK =
  "[&_[cmdk-list-sizer]]:flex [&_[cmdk-list-sizer]]:flex-col [&_[cmdk-list-sizer]]:gap-px";

interface AgentGroup {
  agent: BridgeRegistryAgent;
  family: string;
  models: ModelOption[];
}

/** One flattened, searchable model row. */
interface Row {
  agent: BridgeRegistryAgent;
  family: string;
  model: ModelOption;
}

function effortLevelsForRow(row: Row) {
  return (
    row.model.effortLevels ??
    effortLevelsFor(row.agent.id, row.model.value, null)
  );
}

function rowSupportsEffort(row: Row): boolean {
  return effortLevelsForRow(row).length > 0;
}

function rowSupportsFast(row: Row): boolean {
  return typeof row.model.supportsFast === "boolean"
    ? row.model.supportsFast
    : agentSupportsFast(row.agent.id, row.model.value, null);
}

function agentTitle(agent: BridgeRegistryAgent, family: string): string {
  return agent.name?.trim() || FAMILY_TITLES[family] || family || agent.id;
}

/** What the picker CALLS an agent. Rows are grouped by curated family, so the
 *  catalog's own title wins ("Cursor", not the registry's longer "Cursor
 *  Agent"); a family without one falls back to the registry name. Selection
 *  still reports `agentTitle` — the host persists the registry's name. */
function groupTitle(agent: BridgeRegistryAgent, family: string): string {
  return FAMILY_TITLES[family] || agentTitle(agent, family);
}

export function AgentModelMenu({
  agents: agentsProp,
  initialize = null,
  value,
  onSelect,
  onConfigure,
  open,
  onOpenChange,
  triggerTooltip = "Change model",
  redirectCrossAgent = false,
  children,
}: {
  /** Registry snapshot override (the dispatcher passes its own). When
   *  omitted, the shared agents cache is used (the chat composer). */
  agents?: BridgeRegistryAgent[] | null;
  /** Live capability snapshot for the active chat's agent. Other agent groups
   *  have no active session here and intentionally use the curated fallback. */
  initialize?: InitializeResponse | null;
  /** The current agent + model (drives the collapsed selected row + ✓).
   *  `model: null` resolves to the agent's effective favorite. */
  value: {
    agentId: string | null;
    model: string | null;
    effort: ModelConfiguration["effort"];
    fast: boolean;
  } | null;
  onSelect: (next: AgentModelSelection) => void;
  /** Applies an inline configuration change to the selected chat/dispatcher. */
  onConfigure: (configuration: ModelConfiguration) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Tooltip label on the trigger (empty ⇒ no tooltip). */
  triggerTooltip?: string;
  /** When true (a chat whose session already started), picking a model under a
   *  DIFFERENT agent opens a new chat tab instead of switching in place. */
  redirectCrossAgent?: boolean;
  /** The trigger element (rendered via PopoverTrigger asChild). */
  children: React.ReactNode;
}) {
  const snapshot = useAgentsSnapshot();
  const { isEnabled } = useEnabledAgents();
  // Re-render on any ★ change (this menu reads favorites across families,
  // which a per-family hook can't cover).
  useFavoritesVersion();
  useModelPreferencesVersion();

  const registry = agentsProp !== undefined ? agentsProp : snapshot;

  // Runnable, enabled agents with a curated catalog, in group order. When the
  // registry hasn't loaded yet, degrade to the CURRENT agent alone (from
  // `value`) so the menu still lists its family's models pre-cache.
  const groups = useMemo<AgentGroup[]>(() => {
    const fromRegistry = (registry ?? [])
      .filter((a) => isEnabled(a.id, a.beta) && isRunnableAgent(a))
      .map((agent) => ({
        agent,
        family: agentFamily(agent.id),
        models: modelsForAgent(
          agent.id,
          agent.id === value?.agentId ? initialize : null,
        ),
      }))
      .filter((g) => g.family !== "" && g.models.length > 0)
      .sort(
        (a, b) => (FAMILY_ORDER[a.family] ?? 9) - (FAMILY_ORDER[b.family] ?? 9),
      );
    if (fromRegistry.length > 0) return fromRegistry;
    if (value?.agentId) {
      const family = agentFamily(value.agentId);
      const models = modelsForAgent(value.agentId, initialize);
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
  }, [registry, isEnabled, value?.agentId, initialize]);

  const currentFamily = agentFamily(value?.agentId ?? null);

  // Search resets on every outer open. The unfiltered catalog is a nested,
  // hover/focus-open sidecar; it resets closed so the main surface always
  // starts in the requested selected-only state.
  const [search, setSearch] = useState("");
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [editingModelKey, setEditingModelKeyState] = useState<string | null>(
    null,
  );
  const editingModelKeyRef = useRef<string | null>(null);
  const setEditingModelKey = useCallback((key: string | null) => {
    editingModelKeyRef.current = key;
    setEditingModelKeyState(key);
  }, []);
  useEffect(() => {
    if (!open) return;
    setSearch("");
    setCatalogOpen(false);
    setEditingModelKey(null);
  }, [open, setEditingModelKey]);

  // True while the query is non-empty — universal inline results replace the
  // collapsed selected row and close the unfiltered sidecar.
  const searching = search.trim().length > 0;
  useEffect(() => {
    if (searching) {
      setEditingModelKey(null);
      setCatalogOpen(false);
    }
  }, [searching, setEditingModelKey]);

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

  // A non-empty query searches ALL agents by model label/id or agent title.
  // Empty search intentionally returns no cmdk rows: the selected-model
  // browser below is the sole default row.
  const rows = useMemo<Row[]>(() => {
    if (!searching) return [];
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
          agentTitle(r.agent, r.family).toLowerCase().includes(q),
      );
  }, [groups, search, searching]);

  // The row carrying the ✓: the current agent's current model (null model ⇒
  // its effective favorite, matching what the trigger pill displays).
  const activeModel =
    value?.model ??
    (value?.agentId ? effectiveFavoriteModel(value.agentId) : null);

  // The collapsed row must survive a cold registry and catalog retirement.
  // Prefer the curated row, but synthesize one from the persisted exact model
  // when it no longer appears in today's catalog so the picker never renders
  // an empty Model section for a still-running chat.
  const activeRow: Row | null = (() => {
    if (!value?.agentId || !activeModel) return null;
    const group =
      groups.find((candidate) => candidate.agent.id === value.agentId) ??
      groups.find((candidate) => candidate.family === currentFamily);
    const model = group?.models.find(
      (option) => option.value === activeModel,
    ) ??
      resolveModelOption(value.agentId, activeModel, initialize) ?? {
        value: activeModel,
        label: activeModel,
      };
    return {
      agent:
        group?.agent ??
        ({ id: value.agentId, name: value.agentId } as BridgeRegistryAgent),
      family: currentFamily,
      model,
    };
  })();

  // Exactly one filled star across the catalog. A valid explicit user default
  // wins; otherwise the same connected-provider preference as New Chat picks
  // Codex → Claude → Cursor and that family's catalog fallback.
  const defaultAgent =
    pickDefaultAgent(groups.map((group) => group.agent)) ??
    groups[0]?.agent ??
    null;
  const defaultFamily = agentFamily(defaultAgent?.id ?? null);
  const defaultModel = defaultAgent
    ? effectiveFavoriteModel(defaultAgent.id)
    : null;

  // The editor shows what this exact model will actually run: `effectiveEffort`
  // is the same clamp the composer pill's label and the spawn env apply, so a
  // stored tier the current ladder no longer advertises reads identically in
  // all three places instead of "Ultracode" on the pill and "Max" in here.
  const activeConfiguration: ModelConfiguration | null =
    value?.agentId && activeModel
      ? {
          effort: effectiveEffort(
            value.agentId,
            activeModel,
            value.effort,
            initialize,
          ),
          fast:
            value.fast &&
            agentSupportsFast(value.agentId, activeModel, initialize),
        }
      : null;
  const canConfigureActive =
    !!value?.agentId &&
    !!activeModel &&
    (agentSupportsEffort(value.agentId, activeModel, initialize) ||
      agentSupportsFast(value.agentId, activeModel, initialize));

  const configureActive = (next: Partial<ModelConfiguration>) => {
    if (!value?.agentId || !activeModel || !activeConfiguration) return;
    const configuration = { ...activeConfiguration, ...next };
    rememberModelConfiguration(value.agentId, activeModel, next);
    onConfigure(configuration);
  };

  const pick = (row: Row) => {
    setEditingModelKey(null);
    setCatalogOpen(false);
    onSelect({
      agentId: row.agent.id,
      agentName: agentTitle(row.agent, row.family),
      model: row.model.value,
    });
    onOpenChange(false);
  };

  // The menu no longer owns provider-switch arrows, but it still claims global
  // shortcut priority while open so bare digits type into search instead of
  // toggling a background question card.
  const contentRef = useRef<HTMLDivElement | null>(null);
  const catalogTriggerRef = useRef<HTMLButtonElement | null>(null);
  const catalogContentRef = useRef<HTMLDivElement | null>(null);
  const catalogCloseTimerRef = useRef<number | null>(null);
  const favorite = (row: Row) => {
    starFavoriteModel(row.agent.id, row.model.value);
    // A nested model editor legitimately owns focus while open. Once the user
    // favorites a row, restore the menu's type-immediately invariant instead
    // of leaving focus on that editor's trigger (or the favorite itself).
    contentRef.current
      ?.querySelector<HTMLInputElement>("[cmdk-input]")
      ?.focus({ preventScroll: true });
  };
  useEffect(() => {
    if (!open) return;
    return claimShortcutPriority();
  }, [open]);

  const cancelCatalogClose = () => {
    if (catalogCloseTimerRef.current === null) return;
    window.clearTimeout(catalogCloseTimerRef.current);
    catalogCloseTimerRef.current = null;
  };
  const scheduleCatalogClose = () => {
    cancelCatalogClose();
    catalogCloseTimerRef.current = window.setTimeout(() => {
      catalogCloseTimerRef.current = null;
      const focused = document.activeElement;
      if (
        editingModelKeyRef.current !== null ||
        (focused && catalogTriggerRef.current?.contains(focused)) ||
        (focused && catalogContentRef.current?.contains(focused))
      ) {
        return;
      }
      setEditingModelKey(null);
      setCatalogOpen(false);
    }, 140);
  };
  useEffect(
    () => () => {
      if (catalogCloseTimerRef.current !== null) {
        window.clearTimeout(catalogCloseTimerRef.current);
      }
    },
    [],
  );

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          cancelCatalogClose();
          setEditingModelKey(null);
          setCatalogOpen(false);
        }
        onOpenChange(nextOpen);
      }}
    >
      <Tooltip label={triggerTooltip}>
        <PopoverTrigger asChild>{children}</PopoverTrigger>
      </Tooltip>
      <PopoverContent
        ref={contentRef}
        side="top"
        align="start"
        sideOffset={6}
        className={cn(
          "max-h-[var(--radix-popover-content-available-height)] overflow-y-auto p-0",
          MODEL_POPOVER_WIDTH,
        )}
        // Configuration now precedes the input in DOM order, so Radix would
        // otherwise focus the first reasoning radio. Keep the selector's
        // established type-immediately behavior explicitly.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          contentRef.current
            ?.querySelector<HTMLInputElement>("[cmdk-input]")
            ?.focus();
        }}
        // Skip close-time focus restore so keyboard flow resumes in the
        // composer without painting an unrelated ring on the trigger pill.
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        {/* Active-model configuration stays inline. The Model section below is
            collapsed until search or selected-row hover/focus asks for more. */}
        {canConfigureActive &&
          value?.agentId &&
          activeModel &&
          activeRow &&
          activeConfiguration && (
            <ModelConfigurationEditor
              row={activeRow}
              configuration={activeConfiguration}
              onChange={configureActive}
            />
          )}
        <Command
          shouldFilter={false}
          className={cn(
            "h-auto min-w-0 rounded-none bg-transparent",
            canConfigureActive && "border-border2 border-t",
          )}
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
          <div
            data-model-section-heading="model"
            className={cn(MODEL_SECTION_HEADING, "px-3")}
          >
            Model
          </div>
          <CommandInput
            value={search}
            onValueChange={setSearch}
            placeholder="Search models…"
          />

          {searching ? (
            <CommandList
              className={cn("max-h-[220px] py-1", MODEL_COMMAND_ITEM_STACK)}
              onPointerEnter={() => setHlMode("pointer")}
              onPointerLeave={() => setHlMode("left")}
              onPointerMove={() => {
                if (hlMode === "kb") setHlMode("pointer");
              }}
            >
              <CommandEmpty>No models found.</CommandEmpty>
              {rows.map((row) => {
                const isActive =
                  currentFamily === row.family &&
                  activeModel === row.model.value;
                const isFavorite =
                  defaultFamily === row.family &&
                  defaultModel === row.model.value;
                const configuration =
                  isActive && activeConfiguration
                    ? activeConfiguration
                    : resolveModelConfiguration(
                        row.agent.id,
                        row.model.value,
                        row.agent.id === value?.agentId ? initialize : null,
                      );
                const key = `${row.agent.id}:${row.model.value}`;
                return (
                  <SearchModelRow
                    key={key}
                    row={row}
                    configuration={configuration}
                    isActive={isActive}
                    isFavorite={isFavorite}
                    editorOpen={editingModelKey === key}
                    redirects={
                      redirectCrossAgent && row.family !== currentFamily
                    }
                    highlightMode={hlMode}
                    showCmdkSelection={showCmdkSelection}
                    onPick={() => pick(row)}
                    onEditorOpenChange={(nextOpen) =>
                      setEditingModelKey(nextOpen ? key : null)
                    }
                    onEditorPointerEnter={cancelCatalogClose}
                    onEditorPointerLeave={scheduleCatalogClose}
                    onFavorite={() => favorite(row)}
                  />
                );
              })}
            </CommandList>
          ) : activeRow && activeConfiguration ? (
            <Popover
              open={catalogOpen}
              onOpenChange={(nextOpen) => {
                if (!nextOpen) setEditingModelKey(null);
                setCatalogOpen(nextOpen);
              }}
            >
              <PopoverTrigger asChild>
                <button
                  ref={catalogTriggerRef}
                  type="button"
                  data-testid="selected-model-browser"
                  aria-label={`Browse models; selected ${displayModelLabel(
                    activeRow.agent.id,
                    activeRow.model.label,
                  )}`}
                  aria-expanded={catalogOpen}
                  className={cn(
                    "hover:bg-bg3-hover focus-visible:bg-bg3-hover text-fg1 mx-1 my-1 flex w-[calc(100%_-_0.5rem)] items-center gap-2 rounded-sm px-2 text-left outline-none",
                    MODEL_ROW_HEIGHT,
                  )}
                  onPointerEnter={() => {
                    cancelCatalogClose();
                    setCatalogOpen(true);
                  }}
                  onPointerLeave={scheduleCatalogClose}
                  onFocus={() => setCatalogOpen(true)}
                  onMouseDown={(event) => {
                    // Pointer hover/click must not steal the always-on search
                    // caret; keyboard Tab can still focus this button.
                    event.preventDefault();
                  }}
                  onClick={(event) => {
                    // Radix's trigger normally toggles on click. The catalog
                    // is already open by pointer-enter, so suppress that
                    // composed toggle instead of closing it under the click.
                    event.preventDefault();
                    setCatalogOpen(true);
                  }}
                >
                  <ModelRowDetails
                    row={activeRow}
                    configuration={activeConfiguration}
                    className="flex-1"
                    isFavorite={
                      defaultFamily === activeRow.family &&
                      defaultModel === activeRow.model.value
                    }
                  />
                  <ChevronRight className="text-fg2 size-4 shrink-0" />
                </button>
              </PopoverTrigger>
              <PopoverContent
                ref={catalogContentRef}
                data-testid="model-catalog-sidecar"
                side="right"
                align="end"
                sideOffset={6}
                collisionPadding={8}
                className={cn(
                  "max-h-[var(--radix-popover-content-available-height)] overflow-y-auto p-1",
                  MODEL_POPOVER_WIDTH,
                )}
                onOpenAutoFocus={(event) => event.preventDefault()}
                onCloseAutoFocus={(event) => event.preventDefault()}
                onPointerEnter={cancelCatalogClose}
                onPointerLeave={scheduleCatalogClose}
              >
                {groups.length > 0 ? (
                  groups.map((group, groupIndex) => (
                    <section
                      key={group.agent.id}
                      role="group"
                      aria-label={groupTitle(group.agent, group.family)}
                      // 2px below the last row so a hovered/selected row's
                      // filled background never sits flush against the next
                      // group's separator.
                      className={cn(
                        "pb-0.5",
                        groupIndex > 0 && "border-border2 border-t",
                      )}
                    >
                      <div
                        data-model-section-heading="agent"
                        className={cn(MODEL_SECTION_HEADING, "gap-1.5 px-2")}
                      >
                        {/* Provider mark in its documented brand color, as in
                            Settings → Models, so groups are identifiable
                            before the title is read. */}
                        <AgentIcon
                          agentId={group.agent.id}
                          iconUrl={group.agent.icon ?? null}
                          size={14}
                          className="shrink-0"
                        />
                        {/* The mark inlines its own <title> ("Cursor"), so the
                            visible title carries a hook rather than leaving
                            tests to match ambiguous text. */}
                        <span data-model-section-title>
                          {groupTitle(group.agent, group.family)}
                        </span>
                      </div>
                      <div className={MODEL_ITEM_STACK}>
                        {group.models.map((model) => {
                          const row = {
                            agent: group.agent,
                            family: group.family,
                            model,
                          };
                          const isActive =
                            currentFamily === row.family &&
                            activeModel === row.model.value;
                          const isFavorite =
                            defaultFamily === row.family &&
                            defaultModel === row.model.value;
                          const configuration =
                            isActive && activeConfiguration
                              ? activeConfiguration
                              : resolveModelConfiguration(
                                  row.agent.id,
                                  row.model.value,
                                  row.agent.id === value?.agentId
                                    ? initialize
                                    : null,
                                );
                          const key = `${row.agent.id}:${row.model.value}`;
                          return (
                            <CatalogModelRow
                              key={key}
                              row={row}
                              configuration={configuration}
                              isActive={isActive}
                              isFavorite={isFavorite}
                              editorOpen={editingModelKey === key}
                              redirects={
                                redirectCrossAgent &&
                                row.family !== currentFamily
                              }
                              onPick={() => pick(row)}
                              onEditorOpenChange={(nextOpen) =>
                                setEditingModelKey(nextOpen ? key : null)
                              }
                              onEditorPointerEnter={cancelCatalogClose}
                              onEditorPointerLeave={scheduleCatalogClose}
                              onFavorite={() => favorite(row)}
                            />
                          );
                        })}
                      </div>
                    </section>
                  ))
                ) : (
                  <div className="text-fg2 px-3 py-4 text-center text-xs">
                    No models found.
                  </div>
                )}
              </PopoverContent>
            </Popover>
          ) : (
            <div className="text-fg2 px-3 pb-3 text-xs">No model selected.</div>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function ModelRowDetails({
  row,
  configuration,
  isFavorite = false,
  className,
}: {
  row: Row;
  configuration: ModelConfiguration;
  isFavorite?: boolean;
  className?: string;
}) {
  const showsEffort = rowSupportsEffort(row);
  const metadata = [
    showsEffort ? effortLabel(row.agent.id, configuration.effort) : null,
    configuration.fast && rowSupportsFast(row) ? "Fast" : null,
  ].filter((part): part is string => part !== null);
  return (
    <span
      className={cn(
        "flex min-w-0 items-center gap-1.5 overflow-hidden",
        className,
      )}
      data-model-row-details
    >
      <span data-model-name className="max-w-full shrink-0 truncate text-xs">
        {displayModelLabel(row.agent.id, row.model.label)}
      </span>
      {metadata.length > 0 && (
        <span
          data-model-metadata
          className="text-fg2 min-w-0 truncate text-xs opacity-80"
        >
          {metadata.join(" ")}
        </span>
      )}
      {isFavorite && (
        <Star
          data-default-model-indicator
          role="img"
          aria-label="Default model"
          className="text-fg2 size-3.5 shrink-0 fill-current"
        />
      )}
    </span>
  );
}

function FavoriteModelButton({
  row,
  isFavorite,
  onFavorite,
}: {
  row: Row;
  isFavorite: boolean;
  onFavorite: () => void;
}) {
  const label = displayModelLabel(row.agent.id, row.model.label);
  return (
    <button
      type="button"
      data-model-favorite-action
      data-default-model-indicator={isFavorite ? "" : undefined}
      aria-label={
        isFavorite ? `${label} is the default model` : `Set ${label} as default`
      }
      aria-pressed={isFavorite}
      className={cn(
        "text-fg2 hover:text-fg1 focus-visible:text-fg1 relative z-10 ml-1 flex size-[18px] shrink-0 items-center justify-center rounded-sm outline-none",
        !isFavorite && MODEL_ROW_ACTION_VISIBILITY,
      )}
      onPointerDown={(event) => {
        // Favoriting is metadata-only. Preserve the always-focused search and
        // keep cmdk/the catalog row from treating this as a model selection.
        event.preventDefault();
        event.stopPropagation();
      }}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onFavorite();
      }}
    >
      <Star
        className={cn("size-3.5", isFavorite && "fill-current")}
        aria-hidden="true"
      />
    </button>
  );
}

function modelCanBeConfigured(row: Row): boolean {
  return rowSupportsEffort(row) || rowSupportsFast(row);
}

function SelectedModelTick() {
  return (
    <span
      role="img"
      aria-label="Selected model"
      data-model-row-end-action
      className="text-fg1 absolute right-2 z-10 flex size-4 shrink-0 items-center justify-center"
    >
      <Check className="size-3.5" aria-hidden="true" />
    </span>
  );
}

function ModelConfigurationPopover({
  row,
  configuration,
  open,
  onOpenChange,
  onPointerEnter,
  onPointerLeave,
}: {
  row: Row;
  configuration: ModelConfiguration;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}) {
  const label = displayModelLabel(row.agent.id, row.model.label);
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Edit settings for ${label}`}
          data-model-row-end-action
          className={cn(
            "text-fg2 hover:text-fg1 focus-visible:text-fg1 mr-1 flex h-[18px] shrink-0 items-center justify-center rounded-sm px-1.5 text-[12px] outline-none",
            MODEL_ROW_ACTION_VISIBILITY,
          )}
          onPointerDown={(event) => {
            event.stopPropagation();
          }}
          onMouseDown={(event) => {
            event.stopPropagation();
          }}
          onClick={(event) => {
            // In search mode this button lives inside a cmdk item. Keep its
            // click from selecting the model; the nested Popover trigger still
            // receives the same-element composed event and opens normally.
            event.stopPropagation();
          }}
        >
          Edit
        </button>
      </PopoverTrigger>
      <PopoverContent
        data-testid="model-configuration-popover"
        aria-label={`Model settings for ${label}`}
        side="right"
        align="start"
        sideOffset={6}
        collisionPadding={8}
        className={cn(
          "max-h-[var(--radix-popover-content-available-height)] overflow-y-auto p-0",
          MODEL_POPOVER_WIDTH,
        )}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <ModelConfigurationEditor
          row={row}
          configuration={configuration}
          onChange={(next) =>
            rememberModelConfiguration(row.agent.id, row.model.value, next)
          }
        />
      </PopoverContent>
    </Popover>
  );
}

function ModelRowActions({
  row,
  configuration,
  isActive,
  isFavorite,
  favoritePlacement,
  editorOpen,
  onEditorOpenChange,
  onEditorPointerEnter,
  onEditorPointerLeave,
  onFavorite,
}: {
  row: Row;
  configuration: ModelConfiguration;
  isActive: boolean;
  isFavorite: boolean;
  favoritePlacement: FavoritePlacement;
  editorOpen: boolean;
  onEditorOpenChange: (open: boolean) => void;
  onEditorPointerEnter: () => void;
  onEditorPointerLeave: () => void;
  onFavorite: () => void;
}) {
  return (
    <div
      data-model-row-actions
      className={cn(
        "absolute inset-y-0 z-20 flex items-center bg-transparent pl-1",
        isActive ? "right-7" : "right-1",
        favoritePlacement === "overlay" &&
          (isFavorite
            ? "bg-inherit"
            : "group-focus-within/mi:bg-inherit group-hover/mi:bg-inherit"),
      )}
    >
      {favoritePlacement === "overlay" && (
        <FavoriteModelButton
          row={row}
          isFavorite={isFavorite}
          onFavorite={onFavorite}
        />
      )}
      {!isActive && modelCanBeConfigured(row) && (
        <ModelConfigurationPopover
          row={row}
          configuration={configuration}
          open={editorOpen}
          onOpenChange={onEditorOpenChange}
          onPointerEnter={onEditorPointerEnter}
          onPointerLeave={onEditorPointerLeave}
        />
      )}
    </div>
  );
}

type FavoritePlacement = "inline" | "overlay";

/**
 * Keep the favorite beside the complete model phrase whenever that phrase,
 * the star, and the right-edge action all fit. A long phrase gets the full
 * resting width instead; only its hover/focus actions overlay the tail.
 *
 * Placement is derived from geometry, never hover state, so moving across
 * rows cannot reflow labels or leave a fading background behind. Each open
 * picker contains only the bounded catalog/search result set, making one
 * ResizeObserver per rendered row both deterministic and inexpensive.
 */
function useFavoritePlacement(measureKey: string) {
  const rowRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<FavoritePlacement>("inline");

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;

    const update = () => {
      const details = row.querySelector<HTMLElement>(
        "[data-model-row-details]",
      );
      const name = row.querySelector<HTMLElement>("[data-model-name]");
      const metadata = row.querySelector<HTMLElement>("[data-model-metadata]");
      const favorite = row.querySelector<HTMLElement>(
        "[data-model-favorite-action]",
      );
      if (!details || !name || !favorite) return;

      const rowBox = row.getBoundingClientRect();
      const nameBox = name.getBoundingClientRect();
      const endAction = row.querySelector<HTMLElement>(
        "[data-model-row-end-action]",
      );
      const rowPaddingRight = Number.parseFloat(
        window.getComputedStyle(row).paddingRight,
      );
      const endX = endAction
        ? endAction.getBoundingClientRect().left
        : rowBox.right - Math.max(4, rowPaddingRight || 0);
      const available = Math.max(0, endX - nameBox.left);
      const detailsStyle = window.getComputedStyle(details);
      const parsedGap = Number.parseFloat(
        detailsStyle.columnGap || detailsStyle.gap,
      );
      const phraseWidth =
        name.scrollWidth +
        (metadata
          ? (Number.isFinite(parsedGap) ? parsedGap : 0) + metadata.scrollWidth
          : 0);
      // 4px between phrase/star, plus another 4px before a right-edge action.
      const required =
        phraseWidth +
        4 +
        favorite.getBoundingClientRect().width +
        (endAction ? 4 : 0);
      const next: FavoritePlacement =
        required <= available + 0.5 ? "inline" : "overlay";
      setPlacement((current) => (current === next ? current : next));
    };

    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(row);
    const name = row.querySelector<HTMLElement>("[data-model-name]");
    const metadata = row.querySelector<HTMLElement>("[data-model-metadata]");
    if (name) observer.observe(name);
    if (metadata) observer.observe(metadata);
    let disposed = false;
    void document.fonts?.ready.then(() => {
      if (!disposed) update();
    });
    return () => {
      disposed = true;
      observer.disconnect();
    };
  }, [measureKey]);

  return { placement, rowRef };
}

function SearchModelRow({
  row,
  configuration,
  isActive,
  isFavorite,
  editorOpen,
  redirects,
  highlightMode,
  showCmdkSelection,
  onPick,
  onEditorOpenChange,
  onEditorPointerEnter,
  onEditorPointerLeave,
  onFavorite,
}: {
  row: Row;
  configuration: ModelConfiguration;
  isActive: boolean;
  isFavorite: boolean;
  editorOpen: boolean;
  redirects: boolean;
  highlightMode: "idle" | "pointer" | "left" | "kb";
  showCmdkSelection: boolean;
  onPick: () => void;
  onEditorOpenChange: (open: boolean) => void;
  onEditorPointerEnter: () => void;
  onEditorPointerLeave: () => void;
  onFavorite: () => void;
}) {
  const { placement, rowRef } = useFavoritePlacement(
    `${row.agent.id}:${row.model.value}:${configuration.effort}:${configuration.fast}:${isActive}`,
  );
  return (
    <CommandItem
      ref={rowRef}
      value={`${row.agent.id}:${row.model.value}`}
      data-favorite-placement={placement}
      aria-label={
        redirects
          ? `Open ${displayModelLabel(row.agent.id, row.model.label)} in a new chat with ${groupTitle(row.agent, row.family)}`
          : `Select ${displayModelLabel(row.agent.id, row.model.label)}`
      }
      className={cn(
        "group/mi bg-bg3 hover:bg-bg3-hover focus-within:bg-bg3-hover mx-1 gap-0",
        MODEL_ROW_HEIGHT,
        !showCmdkSelection && "data-[selected=true]:bg-bg3",
        showCmdkSelection &&
          highlightMode === "pointer" &&
          "data-[selected=true]:hover:bg-bg3-hover",
      )}
      onSelect={onPick}
    >
      <ModelRowDetails
        row={row}
        configuration={configuration}
        className={cn(
          placement === "inline" ? "flex-initial" : "flex-1",
          isActive && placement === "overlay" && "pr-7",
        )}
      />
      {placement === "inline" && (
        <FavoriteModelButton
          row={row}
          isFavorite={isFavorite}
          onFavorite={onFavorite}
        />
      )}
      {placement === "inline" && (
        <span className="min-w-0 flex-1" aria-hidden="true" />
      )}
      <ModelRowActions
        row={row}
        configuration={configuration}
        isActive={isActive}
        isFavorite={isFavorite}
        favoritePlacement={placement}
        editorOpen={editorOpen}
        onEditorOpenChange={onEditorOpenChange}
        onEditorPointerEnter={onEditorPointerEnter}
        onEditorPointerLeave={onEditorPointerLeave}
        onFavorite={onFavorite}
      />
      {isActive && <SelectedModelTick />}
    </CommandItem>
  );
}

function CatalogModelRow({
  row,
  configuration,
  isActive,
  isFavorite,
  editorOpen,
  redirects,
  onPick,
  onEditorOpenChange,
  onEditorPointerEnter,
  onEditorPointerLeave,
  onFavorite,
}: {
  row: Row;
  configuration: ModelConfiguration;
  isActive: boolean;
  isFavorite: boolean;
  editorOpen: boolean;
  redirects: boolean;
  onPick: () => void;
  onEditorOpenChange: (open: boolean) => void;
  onEditorPointerEnter: () => void;
  onEditorPointerLeave: () => void;
  onFavorite: () => void;
}) {
  const { placement, rowRef } = useFavoritePlacement(
    `${row.agent.id}:${row.model.value}:${configuration.effort}:${configuration.fast}:${isActive}`,
  );
  return (
    <div
      ref={rowRef}
      data-model-catalog-item
      data-favorite-placement={placement}
      className={cn(
        "group/mi bg-bg3 hover:bg-bg3-hover focus-within:bg-bg3-hover relative flex items-center rounded-sm",
        MODEL_ROW_HEIGHT,
      )}
    >
      <button
        type="button"
        aria-label={
          redirects
            ? `Open ${displayModelLabel(row.agent.id, row.model.label)} in a new chat with ${groupTitle(row.agent, row.family)}`
            : `Select ${displayModelLabel(row.agent.id, row.model.label)}`
        }
        className="absolute inset-0 z-0 rounded-sm text-left outline-none"
        onClick={onPick}
      />
      <ModelRowDetails
        row={row}
        configuration={configuration}
        className={cn(
          "pointer-events-none relative z-10 pl-2",
          placement === "inline" ? "flex-initial" : "flex-1",
          isActive && placement === "overlay" && "pr-7",
        )}
      />
      {placement === "inline" && (
        <FavoriteModelButton
          row={row}
          isFavorite={isFavorite}
          onFavorite={onFavorite}
        />
      )}
      {placement === "inline" && (
        <span
          className="pointer-events-none min-w-0 flex-1"
          aria-hidden="true"
        />
      )}
      <ModelRowActions
        row={row}
        configuration={configuration}
        isActive={isActive}
        isFavorite={isFavorite}
        favoritePlacement={placement}
        editorOpen={editorOpen}
        onEditorOpenChange={onEditorOpenChange}
        onEditorPointerEnter={onEditorPointerEnter}
        onEditorPointerLeave={onEditorPointerLeave}
        onFavorite={onFavorite}
      />
      {isActive && <SelectedModelTick />}
    </div>
  );
}

function ModelConfigurationEditor({
  row,
  configuration,
  onChange,
}: {
  row: Row;
  configuration: ModelConfiguration;
  onChange: (next: Partial<ModelConfiguration>) => void;
}) {
  const levels = effortLevelsForRow(row);
  const supportsFast = rowSupportsFast(row);
  const agentId = row.agent.id;
  const model = row.model.value;
  const reasoningHeadingId = useId();
  const optionsHeadingId = useId();
  return (
    <div className="py-1">
      {levels.length > 0 && (
        <section aria-labelledby={reasoningHeadingId}>
          <div
            id={reasoningHeadingId}
            data-model-section-heading="reasoning"
            className={cn(MODEL_SECTION_HEADING, "px-3")}
          >
            Reasoning
          </div>
          <div
            role="radiogroup"
            aria-label="Reasoning effort"
            className={MODEL_ITEM_STACK}
          >
            {levels.map((level) => {
              const selected = configuration.effort === level;
              return (
                <button
                  key={level}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  className={cn(
                    "hover:bg-bg3-hover text-fg1 flex w-full items-center gap-2 px-3 text-left text-xs",
                    MODEL_ROW_HEIGHT,
                  )}
                  onClick={() => onChange({ effort: level })}
                >
                  <span className="min-w-0 flex-1">
                    {effortLabel(agentId, level)}
                  </span>
                  {selected && <Check className="size-3.5 shrink-0" />}
                </button>
              );
            })}
          </div>
        </section>
      )}
      {supportsFast && (
        <section
          aria-labelledby={optionsHeadingId}
          className={cn(levels.length > 0 && "border-border2 border-t")}
        >
          <div
            id={optionsHeadingId}
            data-model-section-heading="options"
            className={cn(MODEL_SECTION_HEADING, "px-3")}
          >
            Options
          </div>
          <div
            className={cn(
              "text-fg1 flex items-center gap-3 px-3 text-xs",
              MODEL_ROW_HEIGHT,
            )}
          >
            <span className="min-w-0 flex-1">Fast</span>
            <Switch
              checked={configuration.fast}
              onCheckedChange={(fast) => onChange({ fast })}
              aria-label={`Fast mode for ${model}`}
            />
          </div>
        </section>
      )}
    </div>
  );
}
