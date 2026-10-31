// ============================================
// COMPONENT: DesignAdvancedStyleSection
// PURPOSE: Show every authored declaration no dedicated Style control covers
//          as a name/value row, so CSS an agent writes natively (cursor,
//          z-index, margins, custom properties…) is visible and editable,
//          and let a person add any property by name.
// USED IN: DesignStyleEditor, after the dedicated sections
// ============================================

import React, { useId, useMemo, useRef, useState } from "react";
import { Plus, X } from "lucide-react";

import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";

import { Input } from "../../shared/ui/primitives";
import { cn } from "../../shared/ui/cn";
import { designCssPropertySuggestions } from "./design-computed-css";
import { InspectorIconButton, InspectorSection } from "./design-inspector-kit";
import type { DesignLayoutFieldOptions } from "./design-layout-values";
import {
  designAdvancedPropertyName,
  designAdvancedStyleRows,
} from "./design-style-advanced";

interface DesignAdvancedStyleSectionProps {
  details: DesignRuntimeNodeDetails;
  renderField: (
    label: string,
    property: string,
    value: string,
    options?: DesignLayoutFieldOptions,
  ) => React.ReactNode;
  onCommit: (styles: Record<string, string | null>, label: string) => void;
  disabled?: boolean;
}

const ORIGIN_LABELS = {
  inline: "this layer's style attribute",
  frame: "the frame's <style>",
  linked: "a linked stylesheet",
  source: "an imported style source",
} as const;

export function DesignAdvancedStyleSection({
  details,
  renderField,
  onCommit,
  disabled = false,
}: DesignAdvancedStyleSectionProps) {
  const rows = useMemo(() => designAdvancedStyleRows(details), [details]);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const nameRef = useRef<HTMLInputElement | null>(null);
  const suggestionsId = useId();
  const suggestions = useMemo(
    () => (adding ? designCssPropertySuggestions() : []),
    [adding],
  );
  const property = designAdvancedPropertyName(name);

  const reset = () => {
    setAdding(false);
    setName("");
    setValue("");
  };
  const add = () => {
    if (!property || !value.trim()) return;
    onCommit({ [property]: value.trim() }, property);
    reset();
  };

  return (
    <InspectorSection
      title="Advanced"
      data-design-advanced-section=""
      empty={rows.length === 0 && !adding && !details.classes}
      actions={
        <InspectorIconButton
          label="Add property"
          disabled={disabled}
          onClick={() => {
            setAdding(true);
            window.requestAnimationFrame(() => nameRef.current?.focus());
          }}
        >
          <Plus className="size-3" />
        </InspectorIconButton>
      }
    >
      {details.classes ? (
        <p
          className="text-3xxs truncate text-fg3"
          title={details.classes}
          data-design-advanced-classes=""
        >
          <span className="text-muted-fg">class </span>
          {details.classes}
        </p>
      ) : null}
      {rows.map((row) => (
        <div
          key={row.property}
          className="flex items-center gap-1"
          data-design-advanced-property={row.property}
          title={
            row.authored
              ? `${row.property}: ${row.value} — from ${row.authored.selector ? `${row.authored.selector} in ` : ""}${ORIGIN_LABELS[row.authored.origin]}`
              : undefined
          }
        >
          <div className="min-w-0 flex-1">
            {renderField(row.property, row.property, row.value)}
          </div>
          {/* Removing an inline declaration lets the class value show again;
              a rule-owned value is changed in place by editing it. */}
          {row.authored?.origin === "inline" ? (
            <InspectorIconButton
              label={`Remove ${row.property}`}
              size="row"
              disabled={disabled}
              onClick={() => onCommit({ [row.property]: null }, row.property)}
            >
              <X className="size-3" />
            </InspectorIconButton>
          ) : null}
        </div>
      ))}
      {adding ? (
        <form
          className="flex items-center gap-1"
          data-design-advanced-add=""
          onSubmit={(event) => {
            event.preventDefault();
            add();
          }}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            reset();
          }}
        >
          <Input
            ref={nameRef}
            aria-label="Property name"
            placeholder="property"
            list={suggestionsId}
            value={name}
            disabled={disabled}
            spellCheck={false}
            autoComplete="off"
            className={cn(
              "h-7 min-w-0 flex-1 px-2 text-xs",
              name && !property && "border-red-primary",
            )}
            onChange={(event) => setName(event.target.value)}
          />
          <datalist id={suggestionsId}>
            {suggestions.map((suggestion) => (
              <option key={suggestion} value={suggestion} />
            ))}
          </datalist>
          <Input
            aria-label="Property value"
            placeholder="value"
            value={value}
            disabled={disabled}
            spellCheck={false}
            autoComplete="off"
            className="h-7 min-w-0 flex-1 px-2 text-xs"
            onChange={(event) => setValue(event.target.value)}
          />
          <InspectorIconButton
            type="submit"
            label="Add declaration"
            size="row"
            disabled={disabled || !property || !value.trim()}
          >
            <Plus className="size-3" />
          </InspectorIconButton>
        </form>
      ) : null}
    </InspectorSection>
  );
}
