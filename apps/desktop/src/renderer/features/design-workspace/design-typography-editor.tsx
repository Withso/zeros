// ============================================
// COMPONENT: DesignTypographySection
// PURPOSE: Figma-grade type controls: family, weight, size, line height,
//          letter spacing, alignment, and a Type settings popover for the
//          long tail of CSS text properties
// USED IN: DesignStyleEditor
// ============================================

import React, { useEffect, useRef, useState } from "react";
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  ChevronDown,
  Plus,
  Settings2,
  Strikethrough,
  Underline,
} from "lucide-react";

import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";

import {
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
  InspectorIconButton,
  InspectorSection,
  InspectorSegmented,
  InspectorSelect,
  keepDesignPopoverWhileEditing,
  focusDesignPopoverSurface,
} from "./design-inspector-kit";
import type { DesignLayoutFieldOptions } from "./design-layout-values";
import { readDesignComputedStyle } from "./design-style-values";

type RenderField = (
  label: string,
  property: string,
  value: string,
  options?: DesignLayoutFieldOptions,
) => React.ReactNode;

interface DesignTypographySectionProps {
  details: DesignRuntimeNodeDetails;
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
  disabled,
  onCommit,
}: {
  value: string;
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

export function DesignTypographySection({
  details,
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
                <FontFamilyField
                  value={read("font-family")}
                  disabled={disabled}
                  onCommit={(value) => choose("font-family", "font")(value)}
                />
                <div className="grid grid-cols-2 gap-2">
                  <InspectorSelect
                    label="Weight"
                    value={read("font-weight", "400")}
                    options={DESIGN_FONT_WEIGHTS}
                    disabled={disabled}
                    onChange={choose("font-weight", "font weight")}
                  />
                  {renderField("Size", "font-size", read("font-size"), {
                    icon: "font-size",
                  })}
                  {renderField(
                    "Line height",
                    "line-height",
                    read("line-height"),
                    {
                      icon: "line-height",
                    },
                  )}
                  {renderField(
                    "Letter spacing",
                    "letter-spacing",
                    read("letter-spacing"),
                    { icon: "letter-spacing" },
                  )}
                </div>
                <InspectorSegmented
                  label="Text align"
                  value={normalizedAlign(read("text-align", "start"))}
                  disabled={disabled}
                  options={[
                    {
                      value: "start",
                      label: "Align left",
                      icon: <AlignLeft />,
                    },
                    {
                      value: "center",
                      label: "Align center",
                      icon: <AlignCenter />,
                    },
                    {
                      value: "end",
                      label: "Align right",
                      icon: <AlignRight />,
                    },
                    {
                      value: "justify",
                      label: "Justify",
                      icon: <AlignJustify />,
                    },
                  ]}
                  onChange={choose("text-align", "text align")}
                />
                {!textLayer ? (
                  <DesignColorField
                    value={read("color", "currentColor")}
                    label="Text color"
                    property="color"
                    disabled={disabled}
                    onPreview={(value) => onPreview?.({ color: value })}
                    onCancelPreview={onCancelPreview}
                    onCommit={(value) =>
                      onCommit({ color: value }, "text color")
                    }
                  />
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
          className="w-72"
          onEscapeKeyDown={keepDesignPopoverWhileEditing}
        >
          <TypeSettings
            read={read}
            disabled={disabled}
            renderField={renderField}
            choose={choose}
          />
        </PopoverContent>
      ) : null}
    </Popover>
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
    <div className="grid min-w-0 grid-cols-[76px_minmax(0,1fr)] items-center gap-2">
      <span className="zd-row-label">{label}</span>
      {children}
    </div>
  );
}

function TypeSettings({
  read,
  disabled,
  renderField,
  choose,
}: {
  read: (property: string, fallback?: string) => string;
  disabled?: boolean;
  renderField: RenderField;
  choose: (property: string, label: string) => (value: string) => void;
}) {
  const decoration = read(
    "text-decoration-line",
    read("text-decoration", "none"),
  ).split(/\s+/)[0]!;
  return (
    <div className="zd-popover">
      <div className="zd-popover-header">
        <span className="zd-popover-title">Type settings</span>
      </div>
      <SettingRow label="Style">
        <InspectorSegmented
          label="Font style"
          value={
            read("font-style", "normal") === "normal" ? "normal" : "italic"
          }
          disabled={disabled}
          options={[
            { value: "normal", label: "Regular" },
            { value: "italic", label: "Italic" },
          ]}
          onChange={choose("font-style", "font style")}
        />
      </SettingRow>
      <SettingRow label="Case">
        <InspectorSegmented
          label="Case"
          value={read("text-transform", "none")}
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
      <SettingRow label="Decoration">
        <InspectorSegmented
          label="Decoration"
          value={decoration}
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
      <SettingRow label="Truncate">
        <InspectorSegmented
          label="Text overflow"
          value={read("text-overflow", "clip")}
          disabled={disabled}
          options={[
            { value: "clip", label: "Clip" },
            { value: "ellipsis", label: "Ellipsis" },
          ]}
          onChange={choose("text-overflow", "text overflow")}
        />
      </SettingRow>
      <SettingRow label="White space">
        <InspectorSelect
          label="White space"
          value={read("white-space", "normal")}
          disabled={disabled}
          options={[
            { value: "normal", label: "Normal" },
            { value: "nowrap", label: "No wrap" },
            { value: "pre-wrap", label: "Preserve" },
            { value: "break-spaces", label: "Break spaces" },
          ]}
          onChange={choose("white-space", "wrap")}
        />
      </SettingRow>
      <SettingRow label="Line wrap">
        <InspectorSelect
          label="Line wrap"
          value={read("text-wrap", "wrap")}
          disabled={disabled}
          options={[
            { value: "wrap", label: "Wrap" },
            { value: "nowrap", label: "No wrap" },
            { value: "balance", label: "Balance" },
            { value: "pretty", label: "Pretty" },
            { value: "stable", label: "Stable" },
          ]}
          onChange={choose("text-wrap", "line wrap")}
        />
      </SettingRow>
      <SettingRow label="Word break">
        <InspectorSelect
          label="Word break"
          value={read("word-break", "normal")}
          disabled={disabled}
          options={[
            { value: "normal", label: "Normal" },
            { value: "break-all", label: "Break all" },
            { value: "keep-all", label: "Keep all" },
            { value: "break-word", label: "Break word" },
          ]}
          onChange={choose("word-break", "word break")}
        />
      </SettingRow>
      <SettingRow label="Long words">
        <InspectorSelect
          label="Long words"
          value={read("overflow-wrap", "normal")}
          disabled={disabled}
          options={[
            { value: "normal", label: "Normal" },
            { value: "break-word", label: "Break word" },
            { value: "anywhere", label: "Anywhere" },
          ]}
          onChange={choose("overflow-wrap", "long word wrapping")}
        />
      </SettingRow>
      <SettingRow label="Vertical">
        <InspectorSelect
          label="Vertical"
          value={read("vertical-align", "baseline")}
          disabled={disabled}
          options={[
            { value: "baseline", label: "Baseline" },
            { value: "middle", label: "Middle" },
            { value: "top", label: "Top" },
            { value: "bottom", label: "Bottom" },
            { value: "text-top", label: "Text top" },
            { value: "text-bottom", label: "Text bottom" },
            { value: "sub", label: "Subscript" },
            { value: "super", label: "Superscript" },
          ]}
          onChange={choose("vertical-align", "vertical alignment")}
        />
      </SettingRow>
      <SettingRow label="Writing">
        <InspectorSelect
          label="Writing"
          value={read("writing-mode", "horizontal-tb")}
          disabled={disabled}
          options={[
            { value: "horizontal-tb", label: "Horizontal" },
            { value: "vertical-rl", label: "Vertical right" },
            { value: "vertical-lr", label: "Vertical left" },
          ]}
          onChange={choose("writing-mode", "writing mode")}
        />
      </SettingRow>
      <SettingRow label="Hyphens">
        <InspectorSelect
          label="Hyphens"
          value={read("hyphens", "manual")}
          disabled={disabled}
          options={[
            { value: "none", label: "None" },
            { value: "manual", label: "Manual" },
            { value: "auto", label: "Auto" },
          ]}
          onChange={choose("hyphens", "hyphens")}
        />
      </SettingRow>
      <div className="grid grid-cols-2 gap-2">
        {renderField("Word gap", "word-spacing", read("word-spacing", "0px"))}
        {renderField("Indent", "text-indent", read("text-indent", "0px"))}
        {renderField("Stretch", "font-stretch", read("font-stretch", "100%"))}
      </div>
    </div>
  );
}
