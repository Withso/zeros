// ============================================
// COMPONENT: DesignTypographySection
// PURPOSE: Figma-grade type controls: family, weight, size, line height,
//          letter spacing, alignment, and a Type settings popover for the
//          long tail of CSS text properties
// USED IN: DesignStyleEditor
// ============================================

import React, { useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  AlignVerticalJustifyStart,
  ChevronDown,
  Plus,
  Settings2,
  Strikethrough,
  Underline,
} from "lucide-react";

import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";

import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "../../shared/ui/primitives";
import { DesignColorField } from "./design-color-picker";
import {
  InspectorGroup,
  InspectorIconButton,
  InspectorSection,
  InspectorSegmented,
  InspectorSelect,
  keepDesignPopoverWhileEditing,
  focusDesignPopoverSurface,
} from "./design-inspector-kit";
import type { DesignLayoutFieldOptions } from "./design-layout-values";
import { readDesignComputedStyle } from "./design-style-values";
import {
  DesignStyleOriginLabelContext,
  designStyleTokenDisplay,
  useDesignStyleToken,
} from "./design-style-provenance";
import {
  DESIGN_MIXED_VALUE,
  designMixedSegment,
  designMixedSelect,
  designStyleMixed,
  designValuesMixed,
} from "./design-style-mixed";
import {
  designTextStyles,
  designTextStyleSummary,
  type DesignTextStyle,
  type DesignTokenType,
} from "./design-token-catalog";
import { useDesignTokenDetach, useDesignTokens } from "./design-token-context";
import {
  DesignTokenDetachButton,
  DesignTokenPicker,
  DesignTokenPill,
  type DesignTokenListGroup,
} from "./design-token-picker";

type RenderField = (
  label: string,
  property: string,
  value: string,
  options?: DesignLayoutFieldOptions,
) => React.ReactNode;

interface DesignTypographySectionProps {
  details: DesignRuntimeNodeDetails;
  /** Every selected layer whose details are loaded, and how many are
   * selected; together they decide where a field reads Mixed. */
  selection?: readonly DesignRuntimeNodeDetails[];
  selectionCount?: number;
  textLayer: boolean;
  disabled?: boolean;
  isAuthored: (property: string) => boolean;
  renderField: RenderField;
  onPreview?: (styles: Record<string, string | null>) => void;
  onCancelPreview?: () => void;
  onCommit: (styles: Record<string, string | null>, label: string) => void;
}

const TYPOGRAPHY_PROPERTIES = [
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "letter-spacing",
  "text-align",
  "color",
  "font-style",
  "text-transform",
  "text-decoration",
] as const;

export const DESIGN_FONT_WEIGHTS = [
  { value: "100", label: "Thin" },
  { value: "200", label: "Extra Light" },
  { value: "300", label: "Light" },
  { value: "400", label: "Regular" },
  { value: "500", label: "Medium" },
  { value: "600", label: "Semi Bold" },
  { value: "700", label: "Bold" },
  { value: "800", label: "Extra Bold" },
  { value: "900", label: "Black" },
] as const;

const COMMON_FONT_FAMILIES = [
  "system-ui",
  "Inter",
  "Helvetica Neue",
  "Arial",
  "Georgia",
  "Times New Roman",
  "ui-monospace",
  "Menlo",
] as const;

const GENERIC_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "math",
  "emoji",
  "fangsong",
]);

/** The families of a `font-family` stack, unquoted, in order. */
export function designFontFamilies(value: string): string[] {
  const families: string[] = [];
  let current = "";
  let quote = "";
  for (const character of value) {
    if (quote) {
      if (character === quote) quote = "";
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === ",") {
      if (current.trim()) families.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  if (current.trim()) families.push(current.trim());
  return families;
}

function formatFamily(family: string): string {
  return GENERIC_FAMILIES.has(family.toLocaleLowerCase()) ||
    /^[A-Za-z][\w-]*$/.test(family)
    ? family
    : `"${family.replace(/"/g, '\\"')}"`;
}

/** Replace the primary family and keep the authored fallbacks behind it. */
export function designFontStackWithPrimary(
  stack: string,
  family: string,
): string {
  const next = family.trim();
  if (!next) return stack;
  if (next.includes(",")) return next;
  const tail = designFontFamilies(stack)
    .slice(1)
    .filter((entry) => entry.toLocaleLowerCase() !== next.toLocaleLowerCase());
  return [next, ...tail].map(formatFamily).join(", ");
}

function FontFamilyField({
  value,
  placeholder,
  disabled,
  onCommit,
}: {
  value: string;
  placeholder?: string;
  disabled?: boolean;
  onCommit: (value: string) => void;
}) {
  const families = designFontFamilies(value);
  const primary = families[0] ?? "";
  const [draft, setDraft] = useState(primary);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const skipRef = useRef(false);

  useEffect(() => {
    if (document.activeElement !== inputRef.current) setDraft(primary);
  }, [primary]);

  const commit = (family: string) => {
    const next = designFontStackWithPrimary(value, family);
    if (next !== value && family.trim()) onCommit(next);
    else setDraft(primary);
  };

  const suggestions = [
    ...new Set([...families.slice(0, 1), ...COMMON_FONT_FAMILIES]),
  ];

  return (
    <div className="zd-field pr-0.5" data-design-font-family="">
      <input
        ref={inputRef}
        value={draft}
        disabled={disabled}
        spellCheck={false}
        autoComplete="off"
        aria-label="Font"
        placeholder={placeholder}
        className="pl-2"
        onChange={(event) => setDraft(event.currentTarget.value)}
        onFocus={(event) => event.currentTarget.select()}
        onBlur={() => {
          if (skipRef.current) {
            skipRef.current = false;
            return;
          }
          if (draft !== primary) commit(draft);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            event.preventDefault();
            skipRef.current = true;
            setDraft(primary);
            event.currentTarget.blur();
          }
        }}
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            aria-label="Font suggestions"
            className="zd-icon-button"
          >
            <ChevronDown />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-48">
          <DropdownMenuRadioGroup
            value={primary}
            onValueChange={(family) => {
              setDraft(family);
              commit(family);
            }}
          >
            {suggestions.map((family, index) => (
              <React.Fragment key={family}>
                {index === 1 && families.length > 0 ? (
                  <DropdownMenuSeparator />
                ) : null}
                <DropdownMenuRadioItem value={family}>
                  <span style={{ fontFamily: formatFamily(family) }}>
                    {family}
                  </span>
                </DropdownMenuRadioItem>
              </React.Fragment>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function normalizedAlign(value: string): string {
  if (value === "left") return "start";
  if (value === "right") return "end";
  return value || "start";
}

/** A text layer's box places its lines with align-content, which Chromium
 * honours on block containers; in a flex or grid box it means something else. */
const BLOCK_TEXT_DISPLAYS = new Set(["block", "flow-root", "inline-block", "list-item"]);

function verticalAlign(value: string): "start" | "center" | "end" {
  if (value === "center" || value === "safe center") return "center";
  if (value === "end" || value === "flex-end") return "end";
  return "start";
}

export function DesignTypographySection({
  details,
  selection,
  selectionCount = 1,
  textLayer,
  disabled,
  isAuthored,
  renderField,
  onPreview,
  onCancelPreview,
  onCommit,
}: DesignTypographySectionProps) {
  const read = (property: string, fallback = "") =>
    readDesignComputedStyle(details.styles, property) || fallback;
  const mixed = (property: string) =>
    designStyleMixed(selection ?? [details], selectionCount, property);
  const textStyle = useDesignTextStyle(details, selection, selectionCount);
  // A text style's own parts read as values beside its pill, as drawn.
  const styledBy = new Set(textStyle.current ? designTextStyleProperties(textStyle.current) : []);
  const colorToken = useDesignStyleToken(details, "color");
  const verticalAlignable = textLayer && BLOCK_TEXT_DISPLAYS.has(read("display", "block"));
  const authoredTypography = TYPOGRAPHY_PROPERTIES.some((property) =>
    isAuthored(property),
  );
  const [expanded, setExpanded] = useState(false);
  const open = textLayer || authoredTypography || expanded;
  const [settingsOpen, setSettingsOpen] = useState(false);

  const choose = (property: string, label: string) => (value: string) => {
    const styles = { [property]: value };
    onPreview?.(styles);
    onCommit(styles, label);
  };

  // Popovers open beside the inspector, not over it: the whole section is the
  // anchor, so Type settings lands left of the panel at the section's top.
  return (
    <Popover open={settingsOpen} onOpenChange={setSettingsOpen}>
      <PopoverAnchor asChild>
        <div>
          <InspectorSection
            title="Typography"
            empty={!open}
            addable={{ id: "typography", onAdd: () => setExpanded(true) }}
            data-design-typography-section=""
            actions={
              open ? (
                <PopoverTrigger asChild>
                  <InspectorIconButton
                    label="Type settings"
                    disabled={disabled}
                  >
                    <Settings2 />
                  </InspectorIconButton>
                </PopoverTrigger>
              ) : (
                <InspectorIconButton
                  label="Add typography"
                  disabled={disabled}
                  onClick={() => setExpanded(true)}
                >
                  <Plus />
                </InspectorIconButton>
              )
            }
          >
            {open ? (
              <>
                <DesignTextStyleRow
                  textStyle={textStyle}
                  disabled={disabled}
                  onCommit={(styles) => {
                    onPreview?.(styles);
                    onCommit(styles, "text style");
                  }}
                />
                <FontFamilyField
                  value={mixed("font-family") ? "" : read("font-family")}
                  placeholder={mixed("font-family") ? "Mixed" : undefined}
                  disabled={disabled}
                  onCommit={(value) => choose("font-family", "font")(value)}
                />
                <div className="grid grid-cols-2 gap-2">
                  <InspectorSelect
                    label="Weight"
                    {...designMixedSelect(
                      mixed("font-weight"),
                      read("font-weight", "400"),
                      DESIGN_FONT_WEIGHTS,
                    )}
                    disabled={disabled}
                    onChange={(next) => {
                      if (next !== DESIGN_MIXED_VALUE) choose("font-weight", "font weight")(next);
                    }}
                  />
                  {renderField("Size", "font-size", mixed("font-size") ? "" : read("font-size"), {
                    icon: "font-size",
                    mixed: mixed("font-size"),
                    tokenHidden: styledBy.has("font-size"),
                  })}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <InspectorGroup label="Line height">
                    {renderField(
                      "Line height",
                      "line-height",
                      mixed("line-height") ? "" : read("line-height"),
                      { icon: "line-height", mixed: mixed("line-height"), tokenHidden: styledBy.has("line-height") },
                    )}
                  </InspectorGroup>
                  <InspectorGroup label="Letter spacing">
                    {renderField(
                      "Letter spacing",
                      "letter-spacing",
                      mixed("letter-spacing") ? "" : read("letter-spacing"),
                      { icon: "letter-spacing", mixed: mixed("letter-spacing"), tokenHidden: styledBy.has("letter-spacing") },
                    )}
                  </InspectorGroup>
                </div>
                {/* Position's Align buttons move the layer; these place its
                    lines inside it, so their names say text. */}
                <InspectorGroup label="Alignment">
                  <div className={verticalAlignable ? "grid grid-cols-[minmax(0,4fr)_minmax(0,3fr)] gap-2" : undefined}>
                    <InspectorSegmented
                      label="Horizontal alignment"
                      value={designMixedSegment(mixed("text-align"), normalizedAlign(read("text-align", "start")))}
                      disabled={disabled}
                      options={[
                        {
                          value: "start",
                          label: "Align text left",
                          icon: <AlignLeft />,
                        },
                        {
                          value: "center",
                          label: "Align text center",
                          icon: <AlignCenter />,
                        },
                        {
                          value: "end",
                          label: "Align text right",
                          icon: <AlignRight />,
                        },
                        {
                          value: "justify",
                          label: "Justify text",
                          icon: <AlignJustify />,
                        },
                      ]}
                      onChange={choose("text-align", "text align")}
                    />
                    {verticalAlignable ? (
                      <InspectorSegmented
                        label="Vertical alignment"
                        value={designMixedSegment(mixed("align-content"), verticalAlign(read("align-content", "normal")))}
                        disabled={disabled}
                        options={[
                          { value: "start", label: "Align text top", icon: <AlignVerticalJustifyStart /> },
                          { value: "center", label: "Align text middle", icon: <AlignVerticalJustifyCenter /> },
                          { value: "end", label: "Align text bottom", icon: <AlignVerticalJustifyEnd /> },
                        ]}
                        onChange={choose("align-content", "vertical alignment")}
                      />
                    ) : null}
                  </div>
                </InspectorGroup>
                {!textLayer ? (
                  <InspectorGroup label="Color">
                    <DesignColorField
                      value={read("color", "currentColor")}
                      label="Text color"
                      property="color"
                      disabled={disabled}
                      mixed={mixed("color")}
                      {...colorToken}
                      onPreview={(value) => onPreview?.({ color: value })}
                      onCancelPreview={onCancelPreview}
                      onCommit={(value) =>
                        onCommit({ color: value }, "text color")
                      }
                    />
                  </InspectorGroup>
                ) : null}
              </>
            ) : null}
          </InspectorSection>
        </div>
      </PopoverAnchor>
      {open ? (
        <PopoverContent
          data-design-popover=""
          onOpenAutoFocus={focusDesignPopoverSurface}
          side="left"
          align="start"
          sideOffset={8}
          padding="none"
          size="md"
          onEscapeKeyDown={keepDesignPopoverWhileEditing}
        >
          <TypeSettings
            read={read}
            mixed={mixed}
            disabled={disabled}
            renderField={renderField}
            choose={choose}
          />
        </PopoverContent>
      ) : null}
    </Popover>
  );
}

/** The CSS each part of a text style sets, beside its size. */
const TEXT_STYLE_PROPERTIES = [
  ["lineHeight", "line-height"],
  ["letterSpacing", "letter-spacing"],
  ["fontWeight", "font-weight"],
] as const;

/** Applying a text style: its size and each part it declares, as tokens. */
export function designTextStyleStyles(style: DesignTextStyle): Record<string, string> {
  const styles: Record<string, string> = { "font-size": `var(${style.name})` };
  for (const [part, property] of TEXT_STYLE_PROPERTIES) {
    const member = style[part];
    if (member) styles[property] = `var(${member.name})`;
  }
  return styles;
}

/** The directory's text styles and the one every selected layer's size
 * reads, if they share one. */
function useDesignTextStyle(
  details: DesignRuntimeNodeDetails,
  selection: readonly DesignRuntimeNodeDetails[] | undefined,
  selectionCount: number,
): { styles: readonly DesignTextStyle[]; current?: DesignTextStyle; mixed: boolean } {
  const catalog = useDesignTokens();
  const styles = useMemo(() => designTextStyles(catalog), [catalog]);
  const originLabel = useContext(DesignStyleOriginLabelContext);
  if (styles.length === 0 || !originLabel) return { styles, mixed: false };
  const nameOf = (node: DesignRuntimeNodeDetails) =>
    designStyleTokenDisplay(node, "font-size", originLabel)?.name ?? "";
  const mixed = designValuesMixed((selection ?? [details]).map(nameOf), selectionCount);
  const current = mixed ? undefined : styles.find((style) => style.name === nameOf(details));
  return { styles, current, mixed };
}

/** The properties a text style sets on the layer. */
function designTextStyleProperties(style: DesignTextStyle): string[] {
  return [
    "font-size",
    ...TEXT_STYLE_PROPERTIES.filter(([part]) => style[part]).map(([, property]) => property),
  ];
}

const NO_TOKEN_TYPES: readonly DesignTokenType[] = [];

/** Typography's Style row: the text style (`--text-<name>` and its parts)
 * the layer's size reads, as a pill; hidden when the directory has none. */
function DesignTextStyleRow({
  textStyle: { styles, current, mixed },
  disabled,
  onCommit,
}: {
  textStyle: ReturnType<typeof useDesignTextStyle>;
  disabled?: boolean;
  onCommit: (styles: Record<string, string | null>) => void;
}) {
  const detach = useDesignTokenDetach();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const rows = useMemo<DesignTokenListGroup[]>(
    () => [
      {
        key: "text-styles",
        label: "Text styles",
        rows: styles.map((style) => ({
          name: style.name,
          summary: designTextStyleSummary(style),
          glyph: "text" as const,
        })),
      },
    ],
    [styles],
  );
  if (styles.length === 0) return null;
  const label = "Text style";
  // The picker mounts only while open, beside the trigger.
  const trigger = {
    "aria-haspopup": "dialog" as const,
    "aria-expanded": open,
    onClick: () => setOpen((value) => !value),
    onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === "ArrowDown" && event.altKey) {
        event.preventDefault();
        setOpen(true);
      }
    },
  };
  return (
    <InspectorGroup label="Style">
      <div
        data-design-text-style={current?.name ?? ""}
        className="group/design-field zd-field relative min-w-0 pr-0.5 pl-1"
      >
        {current ? (
          <DesignTokenPill
            ref={triggerRef}
            label={label}
            token={{
              name: current.name,
              description: `${current.name.replace(/^--/, "")} · ${designTextStyleSummary(current)}`,
              missing: false,
            }}
            disabled={disabled}
            className="mr-auto"
            {...trigger}
          />
        ) : (
          <Button
            ref={triggerRef}
            type="button"
            variant="ghost"
            size="compact"
            disabled={disabled}
            aria-label={`${label}: ${mixed ? "Mixed" : "none"}`}
            className="text-fg3 w-full justify-between font-normal"
            {...trigger}
          >
            {mixed ? "Mixed" : "None"}
            <ChevronDown aria-hidden="true" />
          </Button>
        )}
        {open ? (
          <DesignTokenPicker
            label={label}
            accepts={NO_TOKEN_TYPES}
            rows={rows}
            kind="text"
            activeName={current?.name ?? null}
            disabled={disabled}
            open
            trigger={triggerRef}
            onOpenChange={setOpen}
            onChoose={(name) => {
              const style = styles.find((candidate) => candidate.name === name);
              if (style) onCommit(designTextStyleStyles(style));
            }}
          />
        ) : null}
        {current && detach ? (
          <span className="zd-field-token-detach" data-design-token-action="hover">
            <DesignTokenDetachButton
              disabled={disabled}
              onDetach={() => detach(designTextStyleProperties(current))}
            />
          </span>
        ) : null}
      </div>
    </InspectorGroup>
  );
}

function SettingRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid min-w-0 grid-cols-[72px_minmax(0,1fr)] items-center gap-2">
      <span className="zd-row-label">{label}</span>
      {children}
    </div>
  );
}

function TypeSettings({
  read,
  mixed,
  disabled,
  renderField,
  choose,
}: {
  read: (property: string, fallback?: string) => string;
  mixed: (property: string) => boolean;
  disabled?: boolean;
  renderField: RenderField;
  choose: (property: string, label: string) => (value: string) => void;
}) {
  const decoration = read(
    "text-decoration-line",
    read("text-decoration", "none"),
  ).split(/\s+/)[0]!;
  /** A select over one property; Mixed while the selected layers differ. */
  const select = (
    label: string,
    property: string,
    fallback: string,
    options: readonly { value: string; label: string }[],
    commitLabel: string,
  ) => {
    const choice = designMixedSelect(mixed(property), read(property, fallback), options);
    const commit = choose(property, commitLabel);
    return (
      <InspectorSelect
        label={label}
        value={choice.value}
        disabled={disabled}
        options={choice.options}
        onChange={(next) => {
          if (next !== DESIGN_MIXED_VALUE) commit(next);
        }}
      />
    );
  };
  return (
    <div className="zd-popover">
      <div className="zd-popover-header">
        <span className="zd-popover-title">Type settings</span>
      </div>
      <SettingRow label="Case">
        <InspectorSegmented
          label="Case"
          value={designMixedSegment(mixed("text-transform"), read("text-transform", "none"))}
          disabled={disabled}
          options={[
            { value: "none", label: "Original", icon: <span>–</span> },
            { value: "uppercase", label: "Uppercase", icon: <span>AB</span> },
            { value: "lowercase", label: "Lowercase", icon: <span>ab</span> },
            { value: "capitalize", label: "Capitalize", icon: <span>Ab</span> },
          ]}
          onChange={choose("text-transform", "case")}
        />
      </SettingRow>
      <SettingRow label="Wrap">
        {select(
          "Line wrap",
          "text-wrap",
          "wrap",
          [
            { value: "wrap", label: "Wrap" },
            { value: "nowrap", label: "No wrap" },
            { value: "balance", label: "Balance" },
            { value: "pretty", label: "Pretty" },
            { value: "stable", label: "Stable" },
          ],
          "line wrap",
        )}
      </SettingRow>
      <SettingRow label="White space">
        {select(
          "White space",
          "white-space",
          "normal",
          [
            { value: "normal", label: "Normal" },
            { value: "nowrap", label: "No wrap" },
            { value: "pre-wrap", label: "Preserve" },
            { value: "break-spaces", label: "Break spaces" },
          ],
          "wrap",
        )}
      </SettingRow>
      <SettingRow label="Truncation">
        <InspectorSegmented
          label="Text overflow"
          value={designMixedSegment(mixed("text-overflow"), read("text-overflow", "clip"))}
          disabled={disabled}
          options={[
            { value: "clip", label: "Clip" },
            { value: "ellipsis", label: "Ellipsis" },
          ]}
          onChange={choose("text-overflow", "text overflow")}
        />
      </SettingRow>
      <SettingRow label="Word break">
        {select(
          "Word break",
          "word-break",
          "normal",
          [
            { value: "normal", label: "Normal" },
            { value: "break-all", label: "Break all" },
            { value: "keep-all", label: "Keep all" },
            { value: "break-word", label: "Break word" },
          ],
          "word break",
        )}
      </SettingRow>
      <SettingRow label="Indent">
        {renderField("Indent", "text-indent", read("text-indent", "0px"), {
          icon: "text-indent",
        })}
      </SettingRow>
      <SettingRow label="Smoothing">
        {select(
          "Smoothing",
          "-webkit-font-smoothing",
          "auto",
          [
            { value: "auto", label: "Auto" },
            { value: "antialiased", label: "Antialiased" },
            { value: "subpixel-antialiased", label: "Subpixel" },
          ],
          "smoothing",
        )}
      </SettingRow>
      <SettingRow label="Decoration">
        <InspectorSegmented
          label="Decoration"
          value={designMixedSegment(
            mixed("text-decoration-line") || mixed("text-decoration"),
            decoration,
          )}
          disabled={disabled}
          options={[
            { value: "none", label: "None", icon: <span>–</span> },
            { value: "underline", label: "Underline", icon: <Underline /> },
            {
              value: "line-through",
              label: "Strikethrough",
              icon: <Strikethrough />,
            },
          ]}
          onChange={choose("text-decoration", "decoration")}
        />
      </SettingRow>
      <SettingRow label="Style">
        <InspectorSegmented
          label="Font style"
          value={designMixedSegment(
            mixed("font-style"),
            read("font-style", "normal") === "normal" ? "normal" : "italic",
          )}
          disabled={disabled}
          options={[
            { value: "normal", label: "Regular" },
            { value: "italic", label: "Italic" },
          ]}
          onChange={choose("font-style", "font style")}
        />
      </SettingRow>
      <SettingRow label="Long words">
        {select(
          "Long words",
          "overflow-wrap",
          "normal",
          [
            { value: "normal", label: "Normal" },
            { value: "break-word", label: "Break word" },
            { value: "anywhere", label: "Anywhere" },
          ],
          "long word wrapping",
        )}
      </SettingRow>
      <SettingRow label="Vertical">
        {select(
          "Vertical",
          "vertical-align",
          "baseline",
          [
            { value: "baseline", label: "Baseline" },
            { value: "middle", label: "Middle" },
            { value: "top", label: "Top" },
            { value: "bottom", label: "Bottom" },
            { value: "text-top", label: "Text top" },
            { value: "text-bottom", label: "Text bottom" },
            { value: "sub", label: "Subscript" },
            { value: "super", label: "Superscript" },
          ],
          "vertical alignment",
        )}
      </SettingRow>
      <SettingRow label="Writing">
        {select(
          "Writing",
          "writing-mode",
          "horizontal-tb",
          [
            { value: "horizontal-tb", label: "Horizontal" },
            { value: "vertical-rl", label: "Vertical right" },
            { value: "vertical-lr", label: "Vertical left" },
          ],
          "writing mode",
        )}
      </SettingRow>
      <SettingRow label="Hyphens">
        {select(
          "Hyphens",
          "hyphens",
          "manual",
          [
            { value: "none", label: "None" },
            { value: "manual", label: "Manual" },
            { value: "auto", label: "Auto" },
          ],
          "hyphens",
        )}
      </SettingRow>
      <SettingRow label="Word gap">
        {renderField("Word gap", "word-spacing", read("word-spacing", "0px"), {
          icon: "word-spacing",
        })}
      </SettingRow>
      <SettingRow label="Stretch">
        {renderField("Stretch", "font-stretch", read("font-stretch", "100%"), {
          icon: "font-stretch",
        })}
      </SettingRow>
    </div>
  );
}
