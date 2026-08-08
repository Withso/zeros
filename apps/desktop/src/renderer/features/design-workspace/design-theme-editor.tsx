// ============================================
// COMPONENT: DesignThemeEditor
// PURPOSE: Dedicated token/mode matrix and bounded CSS-variable import
// USED IN: DesignCanvas bottom toolbar
// ============================================

import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  ClipboardPaste,
  GripHorizontal,
  Palette,
  Plus,
  Search,
  Variable,
  X,
} from "lucide-react";

import type { DesignOperation, DesignTransaction } from "@zeros/design-core";

import type {
  DesignCanvasFrameWire,
  DesignTokenWire,
} from "../../platform/git";
import {
  Button,
  Input,
  Label,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
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
} from "./design-theme-css";
import { DesignColorPicker } from "./design-color-picker";

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
}: {
  token: DesignTokenWire;
  theme: string | null;
  value: string;
  inheritedValue?: string;
  disabled: boolean;
  onCommit: (value: string) => Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const baselineRef = useRef(value);
  const skipCommitRef = useRef(false);
  const effectiveValue = draft || inheritedValue || value;
  const type = inferDesignTokenType(token.name, effectiveValue, token.syntax);
  const inherited = Boolean(theme && !draft && inheritedValue);

  useEffect(() => {
    if (document.activeElement === inputRef.current) return;
    baselineRef.current = value;
    setDraft(value);
  }, [value]);

  const commitValue = async (rawValue: string) => {
    const next = rawValue.trim();
    if (!next || next === baselineRef.current || saving) return;
    setSaving(true);
    try {
      await onCommit(next);
      baselineRef.current = next;
    } catch (error) {
      setDraft(baselineRef.current);
      toast.error(`Couldn't update ${token.name}`, {
        description: errorMessage(error),
      });
    } finally {
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

  return (
    <div className="flex min-w-40 items-center gap-2">
      {type === "color" ? (
        <DesignColorPicker
          value={effectiveValue}
          label={`${token.name} ${theme ?? "base"}`}
          disabled={disabled || saving}
          side="right"
          className="size-6 shrink-0"
          onCommit={async (next) => {
            setDraft(next);
            await commitValue(next);
          }}
        />
      ) : null}
      <Input
        ref={inputRef}
        data-design-theme-value=""
        data-design-theme-inherited={inherited ? "true" : undefined}
        value={draft}
        placeholder={
          theme && inheritedValue ? `Inherited: ${inheritedValue}` : undefined
        }
        disabled={disabled || saving}
        className={cn(
          "h-7 min-w-0 flex-1 font-mono text-xs",
          inherited
            ? "zd-design-control-quiet text-fg3"
            : "zd-design-control-applied",
        )}
        aria-label={`${token.name} ${theme ?? "base"} ${inherited ? "inherited " : ""}value`}
        onFocus={() => {
          skipCommitRef.current = false;
          baselineRef.current = value;
        }}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            event.preventDefault();
            skipCommitRef.current = true;
            setDraft(baselineRef.current);
            event.currentTarget.blur();
          }
        }}
      />
    </div>
  );
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

export function DesignThemeEditor({
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
  const newVariableId = useId();
  const newVariableNameId = `${newVariableId}-name`;
  const newVariableValueId = `${newVariableId}-value`;
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
  const [pasteOpen, setPasteOpen] = useState(false);
  const [cssDraft, setCssDraft] = useState(
    ':root {\n  --brand: rebeccapurple;\n}\n\n[data-theme="dark"] {\n  --brand: mediumpurple;\n}',
  );
  const [newVariableOpen, setNewVariableOpen] = useState(false);
  const [newVariableName, setNewVariableName] = useState("--new-token");
  const [newVariableValue, setNewVariableValue] = useState("");
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
  const groupedTokens = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const groups = new Map<string, DesignTokenWire[]>();
    for (const token of tokens) {
      const type = inferDesignTokenType(token.name, token.value, token.syntax);
      if (
        normalizedQuery &&
        !`${token.name} ${type} ${designTokenGroup(token.name)}`
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
  }, [query, tokens]);

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
      toast.success("CSS variables imported", {
        description: importSummary(parsedImport.imports),
      });
    } catch (error) {
      toast.error("Couldn't import CSS variables", {
        description: errorMessage(error),
      });
    }
  };

  const addVariable = async () => {
    const name = newVariableName.trim();
    const value = newVariableValue.trim();
    if (!name || !value) return;
    try {
      await applyOperations("variable", `Create ${name}`, [
        tokenOperation({ name, theme: null, value }, 0),
      ]);
      setNewVariableOpen(false);
      setNewVariableName("--new-token");
      setNewVariableValue("");
      toast.success("Theme variable created");
    } catch (error) {
      toast.error("Couldn't create the theme variable", {
        description: errorMessage(error),
      });
    }
  };

  const addTheme = async () => {
    const theme = newTheme.trim().toLocaleLowerCase();
    if (!theme) return;
    if (tokens.length === 0) {
      toast.info("Create or import a variable before adding a theme.");
      return;
    }
    if (tokens.length > 256) {
      toast.error("This theme has too many variables for one atomic edit.");
      return;
    }
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
      onActiveThemeChange(theme);
      toast.success(`${theme} theme created`);
    } catch (error) {
      toast.error("Couldn't create the theme", {
        description: errorMessage(error),
      });
    }
  };

  const canEdit = Boolean(
    workspaceId && frame && tokenSourceVersion && action === null,
  );

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
    <DialogPrimitive.Root modal={false} open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          ref={panelRef}
          data-design-theme-editor=""
          aria-modal="false"
          className="border-border2 bg-bg1 fixed z-50 grid h-[min(680px,calc(100vh-48px))] w-[min(760px,calc(100vw-48px))] grid-rows-[auto_auto_minmax(0,1fr)_auto] gap-0 overflow-hidden overscroll-contain rounded-lg border shadow-[var(--shadow-dropdown)] outline-none"
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
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            window.requestAnimationFrame(() => {
              if (onReturnFocus) onReturnFocus();
              else returnFocusRef?.current?.focus();
            });
          }}
        >
          <div className="flex flex-col gap-1 px-4 pt-3 pb-2">
            <div className="flex min-w-0 items-start gap-2">
              <div
                data-design-theme-drag-handle=""
                role="button"
                tabIndex={0}
                aria-label="Move theme editor"
                className="text-fg1 focus-visible:outline-highlighted-bright flex min-w-0 flex-1 cursor-grab touch-none items-center gap-2 rounded-sm py-1 outline-none select-none focus-visible:outline focus-visible:outline-1 active:cursor-grabbing"
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
                <GripHorizontal className="text-fg3 size-4 shrink-0" />
                <Palette className="size-4 shrink-0" />
                <DialogPrimitive.Title className="truncate text-xs font-medium">
                  Theme editor
                </DialogPrimitive.Title>
              </div>
              <DialogPrimitive.Close asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Close theme editor"
                >
                  <X />
                </Button>
              </DialogPrimitive.Close>
            </div>
            <DialogPrimitive.Description className="text-fg3 text-xs">
              Edit CSS variables as a mode matrix. Values stay in tokens.css and
              preview immediately on every live canvas frame.
            </DialogPrimitive.Description>
          </div>

          <div className="flex flex-wrap items-center gap-2 px-4 pb-3">
            <div className="relative min-w-48 flex-1">
              <Search className="text-fg3 pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2" />
              <Input
                value={query}
                className="zd-design-search h-8 pl-7 text-xs"
                aria-label="Search theme variables"
                placeholder="Search variables"
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
                size="sm"
                className="zd-design-control-applied h-8 w-40"
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
            <Button
              type="button"
              variant={pasteOpen ? "secondary-on" : "secondary"}
              size="sm"
              className={cn(
                "zd-design-control-quiet",
                pasteOpen && "zd-design-state-active",
              )}
              onClick={() => {
                setPasteOpen((current) => !current);
                setNewVariableOpen(false);
              }}
            >
              <ClipboardPaste />
              Paste CSS
            </Button>
            <Button
              type="button"
              variant={newVariableOpen ? "secondary-on" : "secondary"}
              size="sm"
              className={cn(
                "zd-design-control-quiet",
                newVariableOpen && "zd-design-state-active",
              )}
              onClick={() => {
                setNewVariableOpen((current) => !current);
                setPasteOpen(false);
              }}
            >
              <Plus />
              Variable
            </Button>
          </div>

          <div className="flex min-h-0 flex-col overflow-hidden">
            {pasteOpen ? (
              <div className="bg-bg1-highlight mx-4 mb-3 flex flex-col gap-3 rounded-lg p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 flex-col">
                    <span className="text-fg1 text-xs font-medium">
                      Paste CSS variables
                    </span>
                    <span className="text-fg3 text-xs">
                      Supports :root, html, :host, [data-theme],
                      [data-zd-theme], .dark, and .theme-name blocks.
                    </span>
                  </div>
                  <span
                    className={cn(
                      "shrink-0 text-xs",
                      parsedImport.error ? "text-red-primary" : "text-fg3",
                    )}
                  >
                    {parsedImport.error ?? importSummary(parsedImport.imports)}
                  </span>
                </div>
                <Textarea
                  value={cssDraft}
                  className="zd-design-control-applied min-h-36 resize-y font-mono text-xs"
                  aria-label="CSS variables to import"
                  spellCheck={false}
                  onChange={(event) => setCssDraft(event.target.value)}
                />
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setPasteOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={
                      !foundation.data ||
                      !!parsedImport.error ||
                      action !== null
                    }
                    onClick={() => void importCss()}
                  >
                    {action === "import" ? "Importing…" : "Import variables"}
                  </Button>
                </div>
              </div>
            ) : null}

            {newVariableOpen ? (
              <div className="bg-bg1-highlight mx-4 mb-3 grid grid-cols-[minmax(160px,1fr)_minmax(160px,2fr)_auto] items-end gap-3 rounded-lg p-4">
                <div className="flex flex-col gap-1">
                  <Label
                    className="text-fg3 text-xs"
                    htmlFor={newVariableNameId}
                  >
                    Variable
                  </Label>
                  <Input
                    id={newVariableNameId}
                    value={newVariableName}
                    className="zd-design-control-applied h-8 font-mono text-xs"
                    onChange={(event) => setNewVariableName(event.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label
                    className="text-fg3 text-xs"
                    htmlFor={newVariableValueId}
                  >
                    Base value
                  </Label>
                  <Input
                    id={newVariableValueId}
                    value={newVariableValue}
                    className="zd-design-control-applied h-8 font-mono text-xs"
                    placeholder="rebeccapurple, 16px, 0.2s…"
                    onChange={(event) =>
                      setNewVariableValue(event.target.value)
                    }
                  />
                </div>
                <Button
                  type="button"
                  size="sm"
                  disabled={
                    !newVariableName.trim() ||
                    !newVariableValue.trim() ||
                    !foundation.data ||
                    action !== null
                  }
                  onClick={() => void addVariable()}
                >
                  {action === "variable" ? "Creating…" : "Create"}
                </Button>
              </div>
            ) : null}

            <ScrollArea data-design-theme-scroll="" className="min-h-0 flex-1">
              <div className="min-w-max pb-3">
                <div
                  className="border-border1 bg-bg1 sticky top-0 z-20 grid border-b"
                  style={{
                    gridTemplateColumns: `minmax(260px, 1.35fr) repeat(${themes.length + 1}, minmax(190px, 1fr))`,
                  }}
                >
                  <div className="text-fg3 bg-bg1 sticky left-0 z-30 px-4 py-2 text-xs font-medium">
                    Variable
                  </div>
                  <div
                    className={cn(
                      "text-fg2 m-1 w-fit rounded-sm px-3 py-1 text-xs font-medium",
                      activeTheme === null && "bg-bg2-hover text-fg1",
                    )}
                  >
                    Base
                  </div>
                  {themes.map((theme) => (
                    <button
                      key={theme}
                      type="button"
                      className={cn(
                        "m-1 w-fit rounded-sm px-3 py-1 text-left text-xs font-medium",
                        activeTheme === theme
                          ? "bg-bg2-hover text-fg1"
                          : "text-fg2",
                      )}
                      onClick={() => onActiveThemeChange(theme)}
                    >
                      {theme}
                    </button>
                  ))}
                </div>

                {groupedTokens.map(([group, rows]) => (
                  <React.Fragment key={group}>
                    <div className="bg-bg1-highlight text-fg3 sticky left-0 z-10 px-4 py-1.5 text-[10px] font-medium tracking-wide uppercase">
                      {group}
                    </div>
                    {rows.map((token) => {
                      const type = inferDesignTokenType(
                        token.name,
                        token.value,
                        token.syntax,
                      );
                      return (
                        <div
                          key={token.name}
                          className="group/token hover:bg-bg1-hover grid min-h-11 items-center"
                          style={{
                            gridTemplateColumns: `minmax(260px, 1.35fr) repeat(${themes.length + 1}, minmax(190px, 1fr))`,
                          }}
                        >
                          <div className="bg-bg1 group-hover/token:bg-bg1-hover sticky left-0 z-10 flex min-w-0 items-center gap-2 px-4 py-2">
                            <Variable className="text-fg3 size-3.5 shrink-0" />
                            <div className="flex min-w-0 flex-1 flex-col">
                              <code className="text-fg1 truncate text-xs">
                                {token.name}
                              </code>
                              <span className="text-fg3 truncate text-[10px]">
                                {type} · {token.usageCount} uses
                              </span>
                            </div>
                          </div>
                          <div className="px-3 py-2">
                            <ThemeValueField
                              token={token}
                              theme={null}
                              value={token.value || token.initialValue}
                              disabled={!canEdit}
                              onCommit={async (value) => {
                                await updateDesignTokenCached(workspaceId!, {
                                  frame: frame!.file,
                                  name: token.name,
                                  theme: null,
                                  value,
                                  sourceVersion: tokenSourceVersion!,
                                });
                              }}
                            />
                          </div>
                          {themes.map((theme) => (
                            <div key={theme} className="px-3 py-2">
                              <ThemeValueField
                                token={token}
                                theme={theme}
                                value={token.themeValues[theme] ?? ""}
                                inheritedValue={
                                  token.value || token.initialValue
                                }
                                disabled={!canEdit}
                                onCommit={async (value) => {
                                  await updateDesignTokenCached(workspaceId!, {
                                    frame: frame!.file,
                                    name: token.name,
                                    theme,
                                    value,
                                    sourceVersion: tokenSourceVersion!,
                                  });
                                }}
                              />
                            </div>
                          ))}
                        </div>
                      );
                    })}
                  </React.Fragment>
                ))}

                {tokens.length === 0 ? (
                  <div className="text-fg3 flex min-h-52 flex-col items-center justify-center gap-2 px-6 text-center text-xs">
                    <Palette className="size-6" />
                    <span>No theme variables yet.</span>
                    <span>
                      Paste CSS variables or create the first variable above.
                    </span>
                  </div>
                ) : groupedTokens.length === 0 ? (
                  <div className="text-fg3 flex min-h-40 items-center justify-center px-6 text-xs">
                    No variables match “{query}”.
                  </div>
                ) : null}
              </div>
            </ScrollArea>
          </div>

          <div className="border-border1 flex items-center justify-between gap-3 border-t px-4 py-3">
            <div className="flex min-w-0 items-center gap-2">
              <Input
                value={newTheme}
                className="zd-design-control-applied h-8 w-40 text-xs"
                placeholder="New theme name"
                aria-label="New theme name"
                onChange={(event) => setNewTheme(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void addTheme();
                  }
                }}
              />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="zd-design-control-quiet"
                disabled={
                  !newTheme.trim() || !foundation.data || action !== null
                }
                onClick={() => void addTheme()}
              >
                <Plus />
                {action?.startsWith("theme:") ? "Adding…" : "Add theme"}
              </Button>
            </div>
            <div className="text-fg3 flex items-center gap-3 text-xs">
              <span>
                {tokens.length} variables · {themes.length + 1} modes
              </span>
              <Button
                type="button"
                size="sm"
                onClick={() => onOpenChange(false)}
              >
                Done
              </Button>
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
