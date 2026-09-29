// ============================================
// COMPONENT: DesignThemeEditor
// PURPOSE: Dedicated token/mode matrix and bounded CSS-variable import
// USED IN: DesignCanvas bottom toolbar
// ============================================

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { publishNativeSurfaceOverlayIntent } from "@/renderer/shared/ui/native-surface-overlay";
import {
  ClipboardPaste,
  Clock3,
  Hash,
  Palette,
  Plus,
  RotateCcw,
  Ruler,
  Search,
  TriangleRight,
  Variable,
} from "lucide-react";

import type { DesignOperation, DesignTransaction } from "@zeros/design-core";

import type {
  DesignCanvasFrameWire,
  DesignTokenWire,
} from "../../platform/git";
import {
  Button,
  DialogCloseButton,
  Input,
  ScrollArea,
  ScrollBar,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  Tooltip,
  toast,
} from "../../shared/ui/primitives";
import { cn } from "../../shared/ui/cn";
import {
  applyDesignTransactionCached,
  updateDesignTokenCached,
} from "./state/design-workspace-cache";
import { useDesignFoundation } from "./state/use-design-foundation";
import {
  designTokenGroup,
  inferDesignTokenType,
  parseDesignCssVariables,
  type DesignCssVariableImport,
  type DesignTokenValueType,
  designThemeVariableNameIssue,
} from "./design-theme-css";
import { DesignColorPicker, DesignColorSwatch } from "./design-color-picker";
import { scrubDesignNumericValue } from "./design-style-values";
import "./design-theme-editor.css";

interface DesignThemeEditorProps {
  workspaceId: string | null;
  frame: DesignCanvasFrameWire | null;
  tokens: readonly DesignTokenWire[];
  tokenSourceVersion: string | null;
  activeTheme: string | null;
  active: boolean;
  open: boolean;
  returnFocusRef?: React.RefObject<HTMLButtonElement | null>;
  onReturnFocus?: () => void;
  onOpenChange: (open: boolean) => void;
  onActiveThemeChange: (theme: string | null) => void;
}

interface ThemeEditorPosition {
  x: number;
  y: number;
}

const THEME_EDITOR_VIEWPORT_MARGIN = 12;
const THEME_TOKEN_TYPES = [
  "color",
  "length",
  "number",
  "time",
  "angle",
  "other",
] as const satisfies readonly DesignTokenValueType[];
const THEME_TYPE_LABELS = {
  all: "All",
  color: "Color",
  length: "Size",
  number: "Number",
  time: "Time",
  angle: "Angle",
  other: "Other",
} as const;
const THEME_TYPE_ICONS = {
  color: Palette,
  length: Ruler,
  number: Hash,
  time: Clock3,
  angle: TriangleRight,
  other: Variable,
} as const;

function clampThemeEditorPosition(
  position: ThemeEditorPosition,
  panel: { width: number; height: number },
): ThemeEditorPosition {
  const maxX = Math.max(
    THEME_EDITOR_VIEWPORT_MARGIN,
    window.innerWidth - panel.width - THEME_EDITOR_VIEWPORT_MARGIN,
  );
  const maxY = Math.max(
    THEME_EDITOR_VIEWPORT_MARGIN,
    window.innerHeight - panel.height - THEME_EDITOR_VIEWPORT_MARGIN,
  );
  return {
    x: Math.min(maxX, Math.max(THEME_EDITOR_VIEWPORT_MARGIN, position.x)),
    y: Math.min(maxY, Math.max(THEME_EDITOR_VIEWPORT_MARGIN, position.y)),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The theme could not be updated.";
}

function ThemeValueField({
  token,
  theme,
  value,
  inheritedValue,
  disabled,
  onCommit,
  onReset,
}: {
  token: DesignTokenWire;
  theme: string | null;
  value: string;
  inheritedValue?: string;
  disabled: boolean;
  onCommit: (value: string) => Promise<void>;
  onReset?: () => Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const swatchRef = useRef<HTMLSpanElement | null>(null);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const baselineRef = useRef(value);
  const skipCommitRef = useRef(false);
  const savingRef = useRef(false);
  const effectiveValue = draft.trim() ? draft : value || inheritedValue || "";
  const type = inferDesignTokenType(token.name, effectiveValue, token.syntax);
  // Inheritance reflects the saved declaration, never an unfinished draft.
  const inherited = Boolean(theme && !value);

  useEffect(() => {
    if (document.activeElement === inputRef.current) return;
    baselineRef.current = value;
    setDraft(value);
  }, [value]);

  const commitValue = async (rawValue: string) => {
    const next = rawValue.trim();
    if (savingRef.current) return;
    if (!next || next === baselineRef.current) {
      setDraft(baselineRef.current);
      return;
    }
    savingRef.current = true;
    setSaving(true);
    try {
      await onCommit(next);
      baselineRef.current = next;
      setDraft(next);
    } catch (error) {
      setDraft(baselineRef.current);
      toast.error(`Couldn't update ${token.name}`, {
        description: errorMessage(error),
      });
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const commit = async () => {
    if (skipCommitRef.current) {
      skipCommitRef.current = false;
      return;
    }
    await commitValue(draft);
  };

  const resetToBase = async () => {
    if (!onReset || disabled || savingRef.current) return;
    const nameFocusTarget = inputRef.current
      ?.closest("[data-design-theme-row]")
      ?.querySelector<HTMLElement>(".zd-theme-token-name");
    // Reset supersedes any local draft; disabling the focused input may blur it.
    skipCommitRef.current = true;
    savingRef.current = true;
    setDraft(baselineRef.current);
    setSaving(true);
    try {
      await onReset();
      baselineRef.current = "";
      setDraft("");
    } catch (error) {
      toast.error(`Couldn't reset ${token.name}`, {
        description: errorMessage(error),
      });
    } finally {
      savingRef.current = false;
      setSaving(false);
      window.requestAnimationFrame(() => {
        // A mode's final override can remove its column from the snapshot.
        const target = inputRef.current ?? nameFocusTarget;
        if (target?.isConnected) target.focus();
      });
    }
  };

  return (
    <Tooltip
      className="zd-theme-tooltip"
      label={inherited ? "Inherits Base" : undefined}
    >
      <div className="zd-field zd-theme-value-field">
        {type === "color" ? (
          <Tooltip
            className="zd-theme-tooltip"
            label={`Edit ${token.name} ${theme ?? "base"} color`}
            shortcut="Alt+↓"
          >
            <span ref={swatchRef} className="zd-theme-swatch-anchor">
              <DesignColorPicker
                value={effectiveValue}
                label={`${token.name} ${theme ?? "base"}`}
                disabled={disabled || saving}
                side="right"
                className="zd-theme-swatch-button"
                trigger={
                  <DesignColorSwatch
                    value={effectiveValue}
                    className="size-3.5"
                  />
                }
                onCommit={async (next) => {
                  setDraft(next);
                  await commitValue(next);
                }}
              />
            </span>
          </Tooltip>
        ) : null}
        <Input
          ref={inputRef}
          data-design-theme-value=""
          data-design-theme-inherited={inherited ? "true" : undefined}
          value={draft}
          placeholder={inherited ? inheritedValue : undefined}
          disabled={disabled || saving}
          className="zd-theme-input"
          aria-label={`${token.name} ${theme ?? "base"} ${inherited ? "inherited " : ""}value`}
          aria-keyshortcuts={
            [
              type === "color" ? "Alt+ArrowDown" : "",
              onReset ? "Alt+Enter" : "",
            ]
              .filter(Boolean)
              .join(" ") || undefined
          }
          onFocus={() => {
            skipCommitRef.current = false;
            baselineRef.current = value;
          }}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.altKey && event.key === "Enter" && onReset) {
              event.preventDefault();
              event.stopPropagation();
              void resetToBase();
            } else if (
              event.altKey &&
              event.key === "ArrowDown" &&
              type === "color"
            ) {
              event.preventDefault();
              event.stopPropagation();
              swatchRef.current?.querySelector("button")?.click();
            } else if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            } else if (event.key === "Escape") {
              event.preventDefault();
              skipCommitRef.current = true;
              setDraft(baselineRef.current);
              event.currentTarget.blur();
            } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
              const direction = event.key === "ArrowUp" ? 1 : -1;
              const next = scrubDesignNumericValue(
                effectiveValue,
                direction * (event.shiftKey ? 10 : 1),
              );
              if (next === null) return;
              event.preventDefault();
              setDraft(next);
            }
          }}
        />
        {onReset ? (
          <Tooltip
            className="zd-theme-tooltip"
            label="Reset to Base"
            shortcut="Alt+Enter"
          >
            <button
              type="button"
              tabIndex={-1}
              className="zd-icon-button zd-theme-reset"
              aria-label="Reset to Base"
              aria-keyshortcuts="Alt+Enter"
              disabled={disabled || saving}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => void resetToBase()}
            >
              <RotateCcw aria-hidden="true" className="size-3.5" />
            </button>
          </Tooltip>
        ) : null}
      </div>
    </Tooltip>
  );
}

/** Keep the row's primary values in Tab order; cell actions also have shortcuts. */
function moveThemeRowFocus(event: React.KeyboardEvent<HTMLDivElement>) {
  if (event.key !== "Tab" || event.defaultPrevented) return;
  const stops = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(
      ".zd-theme-token-name, [data-design-theme-value]:not(:disabled)",
    ),
  );
  const target = event.target as HTMLElement;
  const current = stops.indexOf(target);
  if (current === -1) return;
  const next = stops[current + (event.shiftKey ? -1 : 1)];
  if (!next) return;
  event.preventDefault();
  next.focus();
}

function importSummary(imports: readonly DesignCssVariableImport[]): string {
  const themes = new Set(
    imports
      .map((item) => item.theme)
      .filter((theme): theme is string => !!theme),
  );
  const variables = new Set(imports.map((item) => item.name));
  return `${variables.size} ${variables.size === 1 ? "variable" : "variables"} · ${themes.size} ${themes.size === 1 ? "theme" : "themes"}`;
}

export const DesignThemeEditor = React.memo(function DesignThemeEditor({
  workspaceId,
  frame,
  tokens,
  tokenSourceVersion,
  activeTheme,
  active,
  open,
  returnFocusRef,
  onReturnFocus,
  onOpenChange,
  onActiveThemeChange,
}: DesignThemeEditorProps) {
  const newVariableTriggerRef = useRef<HTMLButtonElement | null>(null);
  const newThemeTriggerRef = useRef<HTMLButtonElement | null>(null);
  const pasteTriggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const positionInitializedRef = useRef(false);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origin: ThemeEditorPosition;
  } | null>(null);
  const [position, setPosition] = useState<ThemeEditorPosition>({ x: 0, y: 0 });
  const [positioned, setPositioned] = useState(false);
  const foundation = useDesignFoundation(
    workspaceId,
    frame?.file,
    frame?.sourceVersion,
    active && Boolean(frame),
  );
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<DesignTokenValueType | "all">(
    "all",
  );
  const [pasteOpen, setPasteOpen] = useState(false);
  const [cssDraft, setCssDraft] = useState(
    ':root {\n  --brand: rebeccapurple;\n}\n\n[data-theme="dark"] {\n  --brand: mediumpurple;\n}',
  );
  const [newVariableOpen, setNewVariableOpen] = useState(false);
  const [newVariableName, setNewVariableName] = useState("");
  const [newVariableValue, setNewVariableValue] = useState("");
  const [newThemeOpen, setNewThemeOpen] = useState(false);
  const [newTheme, setNewTheme] = useState("");
  const [action, setAction] = useState<string | null>(null);

  const themes = useMemo(
    () =>
      [
        ...new Set(tokens.flatMap((token) => Object.keys(token.themeValues))),
      ].sort((left, right) => left.localeCompare(right)),
    [tokens],
  );
  const parsedImport = useMemo(() => {
    try {
      return { imports: parseDesignCssVariables(cssDraft), error: null };
    } catch (error) {
      return { imports: [], error: errorMessage(error) };
    }
  }, [cssDraft]);
  const tokenTypeCounts = useMemo(() => {
    const counts = new Map<DesignTokenValueType, number>();
    for (const token of tokens) {
      const type = inferDesignTokenType(
        token.name,
        token.value || token.initialValue,
        token.syntax,
      );
      counts.set(type, (counts.get(type) ?? 0) + 1);
    }
    return counts;
  }, [tokens]);
  const groupedTokens = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const groups = new Map<string, DesignTokenWire[]>();
    for (const token of tokens) {
      const type = inferDesignTokenType(
        token.name,
        token.value || token.initialValue,
        token.syntax,
      );
      if (typeFilter !== "all" && type !== typeFilter) continue;
      if (
        normalizedQuery &&
        !`${token.name} ${type} ${THEME_TYPE_LABELS[type]} ${designTokenGroup(token.name)}`
          .toLocaleLowerCase()
          .includes(normalizedQuery)
      ) {
        continue;
      }
      const group = designTokenGroup(token.name);
      const rows = groups.get(group) ?? [];
      rows.push(token);
      groups.set(group, rows);
    }
    return [...groups.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    );
  }, [query, tokens, typeFilter]);

  const applyOperations = async (
    key: string,
    intent: string,
    operations: DesignOperation[],
  ) => {
    const data = foundation.data;
    if (!workspaceId || !frame || !data) {
      throw new Error("The selected design document is not ready.");
    }
    if (operations.length === 0) return;
    setAction(key);
    try {
      const transaction: DesignTransaction = {
        schemaVersion: 1,
        transactionId: `desktop:${crypto.randomUUID()}`,
        documentId: data.summary.documentId,
        baseRevision: data.summary.revision,
        actor: { kind: "human", id: "desktop" },
        intent,
        createdAt: Date.now(),
        operations,
      };
      await applyDesignTransactionCached(workspaceId, frame.file, transaction);
    } finally {
      setAction(null);
    }
  };

  const tokenOperation = (
    item: DesignCssVariableImport,
    index: number,
  ): DesignOperation => ({
    operationId: `theme-token-${index}-${crypto.randomUUID()}`,
    type: "token.set",
    file: "tokens.css",
    name: item.name,
    theme: item.theme,
    value: item.value,
  });

  const importCss = async () => {
    if (parsedImport.error || parsedImport.imports.length === 0) return;
    try {
      await applyOperations(
        "import",
        "Import CSS variables",
        parsedImport.imports.map(tokenOperation),
      );
      setPasteOpen(false);
      pasteTriggerRef.current?.focus();
    } catch (error) {
      toast.error("Couldn't import CSS variables", {
        description: errorMessage(error),
      });
    }
  };

  const addVariable = async () => {
    const name = newVariableName.trim();
    const value = newVariableValue.trim();
    if (!name || !value || variableNameInvalid || !canCreate) return;
    try {
      await applyOperations("variable", `Create ${name}`, [
        tokenOperation({ name, theme: null, value }, 0),
      ]);
      setNewVariableOpen(false);
      setNewVariableName("");
      setNewVariableValue("");
      newVariableTriggerRef.current?.focus();
    } catch (error) {
      toast.error("Couldn't create the theme variable", {
        description: errorMessage(error),
      });
    }
  };

  const addTheme = async () => {
    const theme = newTheme.trim().toLocaleLowerCase();
    if (!theme || themeNameInvalid || !canAddTheme) return;
    try {
      await applyOperations(
        `theme:${theme}`,
        `Create ${theme} theme`,
        tokens.map((token, index) =>
          tokenOperation(
            { name: token.name, theme, value: token.value },
            index,
          ),
        ),
      );
      setNewTheme("");
      setNewThemeOpen(false);
      onActiveThemeChange(theme);
      window.requestAnimationFrame(() => newThemeTriggerRef.current?.focus());
    } catch (error) {
      toast.error("Couldn't create the theme", {
        description: errorMessage(error),
      });
    }
  };

  const canEdit = Boolean(
    workspaceId && frame && tokenSourceVersion && action === null,
  );
  const canCreate = Boolean(
    workspaceId && frame && foundation.data && action === null,
  );
  const canAddTheme = canCreate && tokens.length > 0 && tokens.length <= 256;
  const addThemeLabel =
    tokens.length === 0
      ? "Add a variable first"
      : tokens.length > 256
        ? "Themes support up to 256 variables"
        : "Add theme";
  const variableNameIssue = designThemeVariableNameIssue(
    newVariableName,
    tokens,
  );
  const variableNameInvalid = variableNameIssue !== null;
  const themeNameInvalid =
    Boolean(newTheme.trim()) &&
    (!/^[a-z][a-z0-9_-]{0,63}$/.test(newTheme.trim().toLocaleLowerCase()) ||
      themes.includes(newTheme.trim().toLocaleLowerCase()));

  const togglePaste = () => {
    setPasteOpen((current) => !current);
    setNewVariableOpen(false);
  };
  const toggleNewVariable = () => {
    setNewVariableOpen((current) => !current);
    setPasteOpen(false);
  };
  const cancelNewVariable = () => {
    setNewVariableOpen(false);
    setNewVariableName("");
    setNewVariableValue("");
    newVariableTriggerRef.current?.focus();
  };

  const constrainPosition = useCallback((next: ThemeEditorPosition) => {
    const bounds = panelRef.current?.getBoundingClientRect();
    if (!bounds) return next;
    return clampThemeEditorPosition(next, bounds);
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setPositioned(false);
      dragRef.current = null;
      return;
    }
    const place = () => {
      const panel = panelRef.current;
      if (!panel) return;
      const bounds = panel.getBoundingClientRect();
      setPosition((current) => {
        const next = positionInitializedRef.current
          ? current
          : {
              x: (window.innerWidth - bounds.width) / 2,
              y: Math.max(48, (window.innerHeight - bounds.height) / 2),
            };
        positionInitializedRef.current = true;
        return clampThemeEditorPosition(next, bounds);
      });
      setPositioned(true);
    };
    place();
    const placementFrame = window.requestAnimationFrame(place);
    window.addEventListener("resize", place);
    return () => {
      window.cancelAnimationFrame(placementFrame);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  const moveThemeEditorByKeyboard = (
    event: React.KeyboardEvent<HTMLDivElement>,
  ) => {
    const direction = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    }[event.key];
    if (!direction) return;
    event.preventDefault();
    const step = event.shiftKey ? 16 : 4;
    setPosition((current) =>
      constrainPosition({
        x: current.x + direction[0] * step,
        y: current.y + direction[1] * step,
      }),
    );
  };

  return (
    <DialogPrimitive.Root
      modal={false}
      open={open}
      onOpenChange={(nextOpen) => {
        publishNativeSurfaceOverlayIntent(nextOpen);
        onOpenChange(nextOpen);
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          ref={panelRef}
          data-design-theme-editor=""
          aria-modal="false"
          className="zd-theme-editor"
          style={{
            left: position.x,
            top: position.y,
            visibility: positioned ? "visible" : "hidden",
          }}
          onPointerDown={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.stopPropagation()}
          onWheelCapture={(event) => {
            event.stopPropagation();
          }}
          onInteractOutside={(event) => {
            // This is a persistent tool window. Outside interaction remains
            // live but never dismisses an in-progress token edit.
            event.preventDefault();
          }}
          onEscapeKeyDown={(event) => {
            // Draft fields own Escape; it cancels their edit before the window.
            if (
              event.target instanceof HTMLInputElement ||
              event.target instanceof HTMLTextAreaElement
            ) {
              event.preventDefault();
            }
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            window.requestAnimationFrame(() => {
              if (onReturnFocus) onReturnFocus();
              else returnFocusRef?.current?.focus();
            });
          }}
        >
          <div data-design-theme-titlebar="" className="zd-theme-titlebar">
            <div
              data-design-theme-drag-handle=""
              role="button"
              tabIndex={0}
              aria-label="Move theme editor"
              className="zd-theme-drag-handle"
              onPointerDown={(event) => {
                if (event.button !== 0 || !event.isPrimary) return;
                event.preventDefault();
                event.stopPropagation();
                event.currentTarget.setPointerCapture(event.pointerId);
                dragRef.current = {
                  pointerId: event.pointerId,
                  startX: event.clientX,
                  startY: event.clientY,
                  origin: position,
                };
              }}
              onPointerMove={(event) => {
                const drag = dragRef.current;
                if (!drag || drag.pointerId !== event.pointerId) return;
                setPosition(
                  constrainPosition({
                    x: drag.origin.x + event.clientX - drag.startX,
                    y: drag.origin.y + event.clientY - drag.startY,
                  }),
                );
              }}
              onPointerUp={(event) => {
                if (dragRef.current?.pointerId !== event.pointerId) return;
                dragRef.current = null;
                event.currentTarget.releasePointerCapture(event.pointerId);
              }}
              onPointerCancel={(event) => {
                if (dragRef.current?.pointerId !== event.pointerId) return;
                dragRef.current = null;
              }}
              onKeyDown={moveThemeEditorByKeyboard}
            >
              <Palette aria-hidden="true" className="size-3.5 shrink-0" />
              <DialogPrimitive.Title className="zd-theme-title">
                Theme editor
              </DialogPrimitive.Title>
            </div>
            <Tooltip className="zd-theme-tooltip" label="Close theme editor">
              <DialogCloseButton aria-label="Close theme editor" />
            </Tooltip>
            <DialogPrimitive.Description className="sr-only">
              Edit CSS variables and preview themes on the canvas.
            </DialogPrimitive.Description>
          </div>

          <div className="zd-theme-body">
            <div
              data-design-theme-type-filter=""
              role="group"
              aria-label="Filter variables by type"
              className="zd-theme-rail"
            >
              {(["all", ...THEME_TOKEN_TYPES] as const).map((type) => {
                const count =
                  type === "all"
                    ? tokens.length
                    : (tokenTypeCounts.get(type) ?? 0);
                if (type !== "all" && count === 0) return null;
                return (
                  <button
                    key={type}
                    type="button"
                    aria-label={THEME_TYPE_LABELS[type]}
                    aria-pressed={typeFilter === type}
                    className="zd-theme-filter"
                    onClick={() => setTypeFilter(type)}
                  >
                    <span>{THEME_TYPE_LABELS[type]}</span>
                    <span className="zd-theme-filter-count">{count}</span>
                  </button>
                );
              })}
            </div>

            <div className="zd-theme-main">
              <div data-design-theme-toolbar="" className="zd-theme-toolbar">
                <div className="zd-field zd-theme-search">
                  <Search
                    aria-hidden="true"
                    className="text-muted-fg size-3.5 shrink-0"
                  />
                  <Input
                    value={query}
                    className="zd-theme-input"
                    aria-label="Search theme variables"
                    placeholder="Search"
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </div>
                <Select
                  value={activeTheme ?? "__base__"}
                  onValueChange={(value) =>
                    onActiveThemeChange(value === "__base__" ? null : value)
                  }
                >
                  <SelectTrigger
                    className="zd-field zd-theme-preview"
                    aria-label="Preview theme"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__base__">Base</SelectItem>
                    {themes.map((theme) => (
                      <SelectItem key={theme} value={theme}>
                        {theme}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Tooltip className="zd-theme-tooltip" label="Paste CSS">
                  <Button
                    ref={pasteTriggerRef}
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="zd-icon-button"
                    data-size="row"
                    aria-label="Paste CSS"
                    aria-expanded={pasteOpen}
                    onClick={togglePaste}
                  >
                    <ClipboardPaste />
                  </Button>
                </Tooltip>
                <Tooltip className="zd-theme-tooltip" label="New variable">
                  <Button
                    ref={newVariableTriggerRef}
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="zd-icon-button"
                    data-size="row"
                    aria-label="New variable"
                    aria-expanded={newVariableOpen}
                    onClick={toggleNewVariable}
                  >
                    <Plus />
                  </Button>
                </Tooltip>
              </div>

              {pasteOpen ? (
                <div
                  className="zd-theme-paste"
                  onKeyDown={(event) => {
                    if (event.key !== "Escape") return;
                    event.preventDefault();
                    event.stopPropagation();
                    setPasteOpen(false);
                    pasteTriggerRef.current?.focus();
                  }}
                >
                  <Textarea
                    autoFocus
                    value={cssDraft}
                    className="zd-theme-css-input"
                    aria-label="CSS variables to import"
                    aria-invalid={Boolean(parsedImport.error)}
                    spellCheck={false}
                    onChange={(event) => setCssDraft(event.target.value)}
                  />
                  <div className="zd-theme-paste-actions">
                    <span
                      role="status"
                      className={cn(
                        "zd-theme-parse-status",
                        parsedImport.error && "text-red-primary",
                      )}
                    >
                      {parsedImport.error ??
                        importSummary(parsedImport.imports)}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        setPasteOpen(false);
                        pasteTriggerRef.current?.focus();
                      }}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      disabled={
                        !canCreate ||
                        !!parsedImport.error ||
                        parsedImport.imports.length === 0
                      }
                      onClick={() => void importCss()}
                    >
                      {action === "import" ? "Importing…" : "Import"}
                    </Button>
                  </div>
                </div>
              ) : null}

              <ScrollArea
                data-design-theme-scroll=""
                className="zd-theme-scroll"
              >
                <div
                  role="table"
                  aria-label="Theme variables"
                  className="zd-theme-table"
                  style={
                    {
                      "--theme-columns": `minmax(200px, 1.3fr) repeat(${themes.length + 1}, minmax(156px, 1fr)) ${newThemeOpen ? "168px" : newVariableOpen && themes.length === 0 ? "144px" : "40px"}`,
                      minWidth:
                        200 +
                        (themes.length + 1) * 156 +
                        (newThemeOpen
                          ? 168
                          : newVariableOpen && themes.length === 0
                            ? 144
                            : 40),
                    } as React.CSSProperties
                  }
                >
                  <div role="row" className="zd-theme-table-header">
                    <div role="columnheader" className="zd-theme-name-heading">
                      Name
                    </div>
                    {[null, ...themes].map((theme) => (
                      <div
                        key={theme ?? "__base__"}
                        role="columnheader"
                        className="zd-theme-mode-heading"
                      >
                        <button
                          type="button"
                          className={cn(
                            "zd-theme-mode",
                            activeTheme === theme &&
                              "zd-design-theme-mode-active",
                          )}
                          aria-pressed={activeTheme === theme}
                          onClick={() => onActiveThemeChange(theme)}
                        >
                          {theme ?? "Base"}
                        </button>
                      </div>
                    ))}
                    <div role="columnheader" className="zd-theme-add-mode">
                      {newThemeOpen ? (
                        <div className="zd-field">
                          <Input
                            autoFocus
                            value={newTheme}
                            className="zd-theme-input"
                            placeholder="Theme name"
                            aria-label="New theme name"
                            aria-invalid={themeNameInvalid}
                            disabled={!canAddTheme}
                            onChange={(event) =>
                              setNewTheme(event.target.value)
                            }
                            onKeyDown={(event) => {
                              if (event.nativeEvent.isComposing) return;
                              if (event.key === "Enter") {
                                event.preventDefault();
                                void addTheme();
                              } else if (event.key === "Escape") {
                                event.preventDefault();
                                event.stopPropagation();
                                setNewThemeOpen(false);
                                setNewTheme("");
                                window.requestAnimationFrame(() =>
                                  newThemeTriggerRef.current?.focus(),
                                );
                              }
                            }}
                          />
                        </div>
                      ) : (
                        <Tooltip
                          className="zd-theme-tooltip"
                          label={addThemeLabel}
                          side="bottom"
                        >
                          <span
                            className="zd-theme-add-mode-trigger"
                            tabIndex={!canAddTheme ? 0 : undefined}
                          >
                            <Button
                              ref={newThemeTriggerRef}
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="zd-icon-button"
                              data-size="row"
                              aria-label="Add theme"
                              disabled={!canAddTheme}
                              onClick={() => setNewThemeOpen(true)}
                            >
                              <Plus />
                            </Button>
                          </span>
                        </Tooltip>
                      )}
                    </div>
                  </div>

                  {newVariableOpen ? (
                    <div
                      role="row"
                      className="zd-theme-new-variable"
                      onKeyDown={(event) => {
                        if (event.nativeEvent.isComposing) return;
                        if (event.key === "Escape") {
                          event.preventDefault();
                          event.stopPropagation();
                          cancelNewVariable();
                        } else if (event.key === "Enter") {
                          event.preventDefault();
                          void addVariable();
                        }
                      }}
                    >
                      <div role="cell" className="zd-theme-new-name">
                        <div className="zd-field">
                          <Input
                            autoFocus
                            value={newVariableName}
                            className="zd-theme-input"
                            aria-label="Variable name"
                            aria-invalid={variableNameInvalid}
                            placeholder="--name"
                            disabled={action === "variable"}
                            onChange={(event) =>
                              setNewVariableName(event.target.value)
                            }
                          />
                        </div>
                      </div>
                      <div role="cell" className="zd-theme-value-cell">
                        <div className="zd-field">
                          <Input
                            value={newVariableValue}
                            className="zd-theme-input"
                            aria-label="Base value"
                            placeholder="Value"
                            disabled={action === "variable"}
                            onChange={(event) =>
                              setNewVariableValue(event.target.value)
                            }
                          />
                        </div>
                      </div>
                      <div role="cell" className="zd-theme-new-actions">
                        <Tooltip
                          className="zd-theme-tooltip"
                          label={
                            variableNameIssue === "taken"
                              ? `${newVariableName.trim()} already exists`
                              : variableNameIssue === "invalid"
                                ? "Names start with --"
                                : undefined
                          }
                        >
                          <span className="inline-flex">
                            <Button
                              type="button"
                              disabled={
                                !newVariableName.trim() ||
                                variableNameInvalid ||
                                !newVariableValue.trim() ||
                                !canCreate
                              }
                              onClick={() => void addVariable()}
                            >
                              {action === "variable" ? "Creating…" : "Create"}
                            </Button>
                          </span>
                        </Tooltip>
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={cancelNewVariable}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : null}

                  {groupedTokens.map(([group, rows]) => (
                    <React.Fragment key={group}>
                      <div role="row" className="zd-theme-group">
                        <span role="cell" aria-colspan={themes.length + 3}>
                          {group.charAt(0).toLocaleUpperCase() + group.slice(1)}
                        </span>
                      </div>
                      {rows.map((token) => {
                        const value = token.value || token.initialValue;
                        const type = inferDesignTokenType(
                          token.name,
                          value,
                          token.syntax,
                        );
                        const Icon = THEME_TYPE_ICONS[type];
                        return (
                          <div
                            key={token.name}
                            role="row"
                            data-design-theme-row=""
                            className="zd-theme-row"
                            onKeyDown={moveThemeRowFocus}
                          >
                            <div role="cell" className="zd-theme-name-cell">
                              {type === "color" ? (
                                <DesignColorSwatch
                                  value={value}
                                  className="size-3.5"
                                />
                              ) : (
                                <Icon
                                  aria-hidden="true"
                                  className="text-fg3 size-3.5 shrink-0"
                                />
                              )}
                              <Tooltip
                                className="zd-theme-tooltip"
                                label={`${token.name} · ${token.usageCount} ${token.usageCount === 1 ? "use" : "uses"}`}
                              >
                                <span
                                  tabIndex={0}
                                  className="zd-theme-token-name"
                                >
                                  {token.name}
                                </span>
                              </Tooltip>
                            </div>
                            {[null, ...themes].map((theme) => (
                              <div
                                key={theme ?? "__base__"}
                                role="cell"
                                className="zd-theme-value-cell"
                              >
                                <ThemeValueField
                                  token={token}
                                  theme={theme}
                                  value={
                                    theme === null
                                      ? value
                                      : (token.themeValues[theme] ?? "")
                                  }
                                  inheritedValue={
                                    theme === null ? undefined : value
                                  }
                                  disabled={!canEdit}
                                  onCommit={async (next) => {
                                    await updateDesignTokenCached(
                                      workspaceId!,
                                      {
                                        frame: frame!.file,
                                        name: token.name,
                                        theme,
                                        value: next,
                                        sourceVersion: tokenSourceVersion!,
                                      },
                                    );
                                  }}
                                  onReset={
                                    theme !== null &&
                                    token.themeValues[theme] !== undefined &&
                                    foundation.data
                                      ? () =>
                                          applyOperations(
                                            `reset:${theme}:${token.name}`,
                                            `Reset ${token.name} in ${theme} to Base`,
                                            [
                                              {
                                                operationId: `theme-reset-${crypto.randomUUID()}`,
                                                type: "token.set",
                                                file: "tokens.css",
                                                name: token.name,
                                                theme,
                                                value: null,
                                              },
                                            ],
                                          )
                                      : undefined
                                  }
                                />
                              </div>
                            ))}
                            <div role="cell" />
                          </div>
                        );
                      })}
                    </React.Fragment>
                  ))}
                </div>
                {groupedTokens.length === 0 ? (
                  <div className="zd-theme-empty">
                    <Palette aria-hidden="true" className="size-3.5" />
                    <span>No variables</span>
                    {tokens.length === 0 ? (
                      <div className="zd-theme-empty-actions">
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={togglePaste}
                        >
                          Paste CSS
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={toggleNewVariable}
                        >
                          New variable
                        </Button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <ScrollBar orientation="horizontal" />
              </ScrollArea>
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
});
