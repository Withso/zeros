import React, { useContext, useId, useMemo, useRef, useState } from "react";
import { Minus, Plus } from "lucide-react";

import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";

import { Input } from "../../shared/ui/primitives";
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

/** More styles: the authored declarations no Style control above covers, so
 * CSS an agent or a stylesheet writes stays visible and editable, and any
 * property can be added by name. Classes belong to the markup and are not
 * listed here. */
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

  const startAdding = () => {
    setAdding(true);
    window.requestAnimationFrame(() => nameRef.current?.focus());
  };

  return (
    <InspectorSection
      title="More styles"
      data-design-advanced-section=""
      empty={rows.length === 0 && !adding}
      actions={
        <InspectorIconButton
          label="Add style"
          disabled={disabled}
          onClick={startAdding}
        >
          <Plus className="size-3" />
        </InspectorIconButton>
      }
    >
      {rows.length > 0 ? (
        <p className="zd-section-note">
          Styles no control above covers, as an agent or the CSS wrote them.
        </p>
      ) : null}
      {rows.map((row) => (
        <div
          key={row.property}
          className="flex items-center gap-0.5"
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
              disabled={disabled}
              onClick={() => onCommit({ [row.property]: null }, row.property)}
            >
              <Minus />
            </InspectorIconButton>
          ) : null}
        </div>
      ))}
      {adding ? (
        <form
          className="flex items-center gap-2"
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
          {/* Filled inspector fields; an unsupported name or value draws the
              field's red edge through aria-invalid. */}
          <div className="zd-field min-w-0 flex-1">
            <Input
              ref={nameRef}
              aria-label="Property name"
              aria-invalid={Boolean(name) && !(property && support.name)}
              placeholder="property"
              list={suggestionsId}
              value={name}
              disabled={disabled}
              spellCheck={false}
              autoComplete="off"
              className="h-full px-2"
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <datalist id={suggestionsId}>
            {suggestions.map((suggestion) => (
              <option key={suggestion} value={suggestion} />
            ))}
          </datalist>
          <div className="zd-field min-w-0 flex-1">
            <Input
              aria-label="Property value"
              aria-invalid={Boolean(property && support.name && !support.value)}
              placeholder="value"
              value={value}
              disabled={disabled}
              spellCheck={false}
              autoComplete="off"
              className="h-full px-2"
              onChange={(event) => setValue(event.target.value)}
            />
          </div>
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
