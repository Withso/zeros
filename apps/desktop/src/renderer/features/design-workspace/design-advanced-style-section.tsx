import React, { useContext, useId, useMemo, useRef, useState } from "react";
import { Plus, X } from "lucide-react";

import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";

import { Input, Label } from "../../shared/ui/primitives";
import { cn } from "../../shared/ui/cn";
import { designCssPropertySuggestions } from "./design-computed-css";
import { InspectorIconButton, InspectorSection } from "./design-inspector-kit";
import type { DesignLayoutFieldOptions } from "./design-layout-values";
import {
  designAdvancedDeclarationSupport,
  designAdvancedPropertyName,
  designAdvancedStyleRows,
  type DesignAdvancedStyleRow,
} from "./design-style-advanced";
import {
  DesignStyleOriginLabelContext,
  type DesignStyleOriginLabel,
} from "./design-style-provenance";

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

function provenanceTitle(
  row: DesignAdvancedStyleRow,
  label: DesignStyleOriginLabel | null,
): string | undefined {
  if (!row.authored) return undefined;
  const where = [row.authored.selector, label?.(row.authored)].filter(Boolean).join(" in ");
  return `${row.property}: ${row.value}${where ? ` — from ${where}` : ""}`;
}

/** Lists the authored declarations no dedicated Style control covers, so CSS
 * an agent writes natively stays visible and editable, and adds any property
 * by name. */
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
  const classesId = useId();
  const suggestionsId = useId();
  const suggestions = useMemo(
    () => (adding ? designCssPropertySuggestions() : []),
    [adding],
  );
  const originLabel = useContext(DesignStyleOriginLabelContext);
  const property = designAdvancedPropertyName(name);
  const support = property
    ? designAdvancedDeclarationSupport(property, value)
    : { name: false, value: true };
  const ready = !!property && support.name && support.value && !!value.trim();

  const reset = () => {
    setAdding(false);
    setName("");
    setValue("");
  };
  const add = () => {
    if (!ready || !property) return;
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
      {/* The markup owns a layer's classes, so this row is read-only; its
          field scrolls rather than truncating them. */}
      {details.classes ? (
        <div
          className="zd-field zd-inspector-field relative overflow-hidden"
          data-design-advanced-classes=""
          data-design-field-readonly=""
        >
          <span className="zd-field-label pr-1.5 pl-2 whitespace-nowrap">
            <Label htmlFor={classesId} className="text-inherit">
              class
            </Label>
          </span>
          <Input
            id={classesId}
            readOnly
            value={details.classes}
            spellCheck={false}
            autoComplete="off"
            className="h-full min-w-0 flex-1 rounded-none border-0 bg-transparent py-0 pr-2 pl-0 font-sans text-xs text-fg1 shadow-none focus-visible:border-transparent"
          />
        </div>
      ) : null}
      {rows.map((row) => (
        <div
          key={row.property}
          className="flex items-center gap-1"
          data-design-advanced-property={row.property}
          title={provenanceTitle(row, originLabel)}
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
              name && !(property && support.name) && "border-red-primary",
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
            className={cn(
              "h-7 min-w-0 flex-1 px-2 text-xs",
              property && support.name && !support.value && "border-red-primary",
            )}
            onChange={(event) => setValue(event.target.value)}
          />
          <InspectorIconButton
            type="submit"
            label="Add declaration"
            size="row"
            disabled={disabled || !ready}
          >
            <Plus className="size-3" />
          </InspectorIconButton>
        </form>
      ) : null}
    </InspectorSection>
  );
}
