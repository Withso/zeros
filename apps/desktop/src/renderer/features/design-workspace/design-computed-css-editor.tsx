import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  bracketMatching,
  HighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  keymap,
  placeholder,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";

import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";

import { resolveCodeTheme } from "../../shared/theme/code-themes";
import { useCodeTheme } from "../../shared/theme/use-code-theme";
import { resolveLanguage } from "../../shell/workbench/tabs/code-editor/language";
import {
  computedDesignCssDeclarations,
  designCssPropertySuggestions,
  designCssValueSuggestions,
  diffDesignCssDeclarations,
} from "./design-computed-css";
import {
  parseDesignCssDeclarations,
  serializeDesignCssDeclarations,
} from "./design-style-values";

interface DesignComputedCssEditorProps {
  details: DesignRuntimeNodeDetails;
  disabled?: boolean;
  onPreviewStyles?: (styles: Record<string, string | null>) => Promise<void>;
  onCancelStylePreview?: () => Promise<void>;
  onCommitStyles: (styles: Record<string, string | null>) => Promise<void>;
}

const CSS_AUTOSAVE_DELAY_MS = 300;
const MAX_CSS_DECLARATIONS = 128;
const MAX_CSS_PATCH_PROPERTIES = 64;

const cssHighlightStyle = HighlightStyle.define([
  { tag: tags.propertyName, color: "var(--red-primary)" },
  {
    tag: [tags.number, tags.string, tags.color, tags.atom, tags.bool],
    color: "var(--fg1)",
  },
  {
    tag: [tags.punctuation, tags.separator],
    color: "var(--fg2)",
  },
]);

function designCssEditorTheme(dark: boolean): Extension {
  return EditorView.theme(
    {
      "&": {
        height: "100%",
        backgroundColor: "var(--bg1)",
        color: "var(--fg1)",
        fontSize: "12px",
      },
      "&.cm-focused": { outline: "none" },
      ".cm-scroller": {
        overflow: "auto",
        fontFamily: "var(--font-mono)",
        lineHeight: "1.75",
      },
      ".cm-content": {
        minWidth: "max-content",
        padding: "12px 0 24px",
        caretColor: "var(--fg1)",
      },
      ".cm-line": { padding: "0 14px" },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--fg1)" },
      ".cm-activeLine": {
        backgroundColor: "color-mix(in srgb, var(--fg1) 4%, transparent)",
      },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
        {
          backgroundColor: "color-mix(in srgb, var(--fg1) 18%, transparent)",
        },
      ".cm-placeholder": {
        color: "var(--muted-fg)",
        fontStyle: "normal",
      },
      ".cm-tooltip": {
        overflow: "hidden",
        border: "1px solid var(--border2)",
        borderRadius: "8px",
        backgroundColor: "var(--bg2)",
        color: "var(--fg1)",
        boxShadow: "0 12px 32px color-mix(in srgb, black 24%, transparent)",
      },
      ".cm-tooltip.cm-tooltip-autocomplete > ul": {
        maxHeight: "240px",
        fontFamily: "var(--font-sans)",
      },
      ".cm-tooltip-autocomplete ul li": {
        minHeight: "30px",
        padding: "5px 10px",
      },
      ".cm-tooltip-autocomplete ul li[aria-selected]": {
        backgroundColor: "var(--bg3)",
        color: "var(--fg1)",
      },
      ".cm-completionIcon": { display: "none" },
      ".cm-completionMatchedText": {
        color: "var(--fg1)",
        textDecoration: "none",
      },
    },
    { dark },
  );
}

function designCssCompletionSource(
  context: CompletionContext,
): CompletionResult | null {
  const line = context.state.doc.lineAt(context.pos);
  const offset = context.pos - line.from;
  const beforeCursor = line.text.slice(0, offset);
  const colon = beforeCursor.indexOf(":");

  if (colon < 0) {
    const token = context.matchBefore(/(?:--)?[-A-Za-z0-9_]*/);
    if (!token || (!context.explicit && token.from === token.to)) return null;
    return {
      from: token.from,
      options: designCssPropertySuggestions().map((property) => ({
        label: property,
        type: "property",
        apply: `${property}: `,
      })),
      validFor: /(?:--)?[-A-Za-z0-9_]*/,
    };
  }

  const property = beforeCursor.slice(0, colon).trim().toLocaleLowerCase();
  if (!property) return null;
  const token = context.matchBefore(/[-A-Za-z0-9.%()]*/);
  if (!token) return null;
  const query = token.text.toLocaleLowerCase();
  const suggestions = designCssValueSuggestions(property);
  const orderedSuggestions = query
    ? [
        ...suggestions.filter((value) =>
          value.toLocaleLowerCase().startsWith(query),
        ),
        ...suggestions.filter(
          (value) => !value.toLocaleLowerCase().startsWith(query),
        ),
      ]
    : suggestions;
  return {
    from: token.from,
    options: orderedSuggestions.map((value) => ({
      label: value,
      type: "value",
    })),
    filter: false,
  };
}

const baseExtensions: readonly Extension[] = [
  drawSelection(),
  EditorState.allowMultipleSelections.of(true),
  bracketMatching(),
  closeBrackets(),
  history(),
  autocompletion({
    activateOnTyping: true,
    maxRenderedOptions: 30,
    override: [designCssCompletionSource],
  }),
  syntaxHighlighting(cssHighlightStyle),
  placeholder("property: value;"),
  keymap.of([
    ...closeBracketsKeymap,
    ...completionKeymap,
    ...defaultKeymap,
    ...historyKeymap,
    indentWithTab,
  ]),
];

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The CSS could not be updated.";
}

function validateSupportedCss(
  declarations: Readonly<Record<string, string>>,
): void {
  if (typeof CSS === "undefined" || typeof CSS.supports !== "function") return;
  for (const [property, value] of Object.entries(declarations)) {
    if (property.startsWith("--") || CSS.supports(property, value)) continue;
    throw new Error(`“${value}” is not a supported value for ${property}.`);
  }
}

/** A declaration editor backed by computed runtime values. Valid edits paint
 * immediately, coalesce into one source mutation, and flush before focus leaves
 * so the Design surface's global Command-S can stage the newest source. */
export function DesignComputedCssEditor({
  details,
  disabled = false,
  onPreviewStyles,
  onCancelStylePreview,
  onCommitStyles,
}: DesignComputedCssEditorProps) {
  const externalDeclarations = useMemo(
    () => computedDesignCssDeclarations(details),
    [details],
  );
  const externalSource = useMemo(
    () => serializeDesignCssDeclarations(externalDeclarations),
    [externalDeclarations],
  );
  const [draft, setDraft] = useState(externalSource);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [cssLanguage, setCssLanguage] = useState<Extension | null>(null);
  const appearance = resolveCodeTheme(useCodeTheme()).appearance;

  const mountedRef = useRef(false);
  const baselineRef = useRef<Record<string, string>>(externalDeclarations);
  const validTargetRef = useRef<Record<string, string> | null>(
    externalDeclarations,
  );
  const previewTargetRef = useRef<Record<string, string>>(externalDeclarations);
  const lastAcceptedExternalSourceRef = useRef(externalSource);
  const versionRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const commitInFlightRef = useRef(false);
  const rerunRef = useRef(false);
  const flushRef = useRef<() => void>(() => {});
  const actionsRef = useRef({
    onPreviewStyles,
    onCancelStylePreview,
    onCommitStyles,
  });
  actionsRef.current = {
    onPreviewStyles,
    onCancelStylePreview,
    onCommitStyles,
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void resolveLanguage("computed.css").then((extension) => {
      if (!cancelled) setCssLanguage(extension);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const scheduleFlush = useCallback((delay: number) => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    if (!mountedRef.current) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      flushRef.current();
    }, delay);
  }, []);

  const flushValidDraft = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    // A flush that outlives this editor must not land. `onCommitStyles`
    // resolves its target from the live selection, so a write queued while a
    // commit was in flight would move these declarations onto whichever layer
    // the designer selected next. Blur already flushes the real edit before
    // the selection changes.
    if (!mountedRef.current) return;
    const target = validTargetRef.current;
    if (!target) return;
    if (commitInFlightRef.current) {
      rerunRef.current = true;
      return;
    }
    const patch = diffDesignCssDeclarations(baselineRef.current, target);
    if (Object.keys(patch).length === 0) {
      setDirty(false);
      void actionsRef.current.onCancelStylePreview?.().catch(() => {});
      return;
    }

    const committedTarget = target;
    const committedVersion = versionRef.current;
    commitInFlightRef.current = true;
    rerunRef.current = false;
    setSaving(true);
    void actionsRef.current
      .onCommitStyles(patch)
      .then(() => {
        baselineRef.current = committedTarget;
        const current = validTargetRef.current;
        const currentPatch = current
          ? diffDesignCssDeclarations(committedTarget, current)
          : null;
        const settled =
          versionRef.current === committedVersion &&
          currentPatch !== null &&
          Object.keys(currentPatch).length === 0;
        if (mountedRef.current) {
          setError(null);
          setDirty(!settled);
        }
        if (settled) {
          void actionsRef.current.onCancelStylePreview?.().catch(() => {});
        }
      })
      .catch((commitError: unknown) => {
        if (mountedRef.current) {
          setError(errorMessage(commitError));
          setDirty(true);
        }
        void actionsRef.current.onCancelStylePreview?.().catch(() => {});
      })
      .finally(() => {
        commitInFlightRef.current = false;
        if (!mountedRef.current) return;
        setSaving(false);
        if (
          validTargetRef.current &&
          (rerunRef.current || versionRef.current !== committedVersion)
        ) {
          scheduleFlush(0);
        }
      });
  }, [scheduleFlush]);
  flushRef.current = flushValidDraft;

  const handleChange = useCallback(
    (nextDraft: string) => {
      setDraft(nextDraft);
      versionRef.current += 1;
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      try {
        const next = parseDesignCssDeclarations(
          nextDraft,
          MAX_CSS_DECLARATIONS,
        );
        validateSupportedCss(next);
        const commitPatch = diffDesignCssDeclarations(
          baselineRef.current,
          next,
        );
        const commitPatchSize = Object.keys(commitPatch).length;
        if (commitPatchSize > MAX_CSS_PATCH_PROPERTIES) {
          throw new Error("Edit no more than 64 CSS properties at once.");
        }
        const previewPatch = diffDesignCssDeclarations(
          previewTargetRef.current,
          next,
        );
        validTargetRef.current = next;
        previewTargetRef.current = next;
        setError(null);
        setDirty(commitPatchSize > 0);
        if (Object.keys(previewPatch).length > 0) {
          void actionsRef.current
            .onPreviewStyles?.(previewPatch)
            .catch(() => {});
        }
        if (commitPatchSize === 0) {
          void actionsRef.current.onCancelStylePreview?.().catch(() => {});
          return;
        }
        scheduleFlush(CSS_AUTOSAVE_DELAY_MS);
      } catch (draftError) {
        validTargetRef.current = null;
        previewTargetRef.current = baselineRef.current;
        setDirty(true);
        setError(errorMessage(draftError));
        void actionsRef.current.onCancelStylePreview?.().catch(() => {});
      }
    },
    [scheduleFlush],
  );

  useEffect(() => {
    if (
      focused ||
      dirty ||
      saving ||
      externalSource === lastAcceptedExternalSourceRef.current
    ) {
      return;
    }
    lastAcceptedExternalSourceRef.current = externalSource;
    baselineRef.current = externalDeclarations;
    validTargetRef.current = externalDeclarations;
    previewTargetRef.current = externalDeclarations;
    setDraft(externalSource);
    setError(null);
  }, [dirty, externalDeclarations, externalSource, focused, saving]);

  const extensions = useMemo(
    () => [
      ...baseExtensions,
      designCssEditorTheme(appearance === "dark"),
      EditorView.contentAttributes.of({
        "aria-label": "Computed CSS declarations",
        spellcheck: "false",
        autocapitalize: "off",
        autocomplete: "off",
      }),
      ...(cssLanguage ? [cssLanguage] : []),
    ],
    [appearance, cssLanguage],
  );

  return (
    <div
      data-design-computed-css-editor=""
      className="bg-bg1 flex min-h-0 flex-1 flex-col"
      aria-busy={saving}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (
          event.relatedTarget instanceof Node &&
          event.currentTarget.contains(event.relatedTarget)
        ) {
          return;
        }
        setFocused(false);
        flushRef.current();
      }}
    >
      <div className="min-h-0 flex-1">
        <CodeMirror
          value={draft}
          editable={!disabled}
          readOnly={disabled}
          basicSetup={false}
          theme="none"
          height="100%"
          style={{ height: "100%" }}
          extensions={extensions}
          onChange={handleChange}
        />
      </div>
      {error ? (
        <div
          role="alert"
          className="border-border1 text-red-primary shrink-0 border-t px-3 py-2 text-[11px] leading-4"
        >
          {error}
        </div>
      ) : null}
    </div>
  );
}
