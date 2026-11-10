import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";

import type { InspectorOption } from "./design-inspector-kit";
import { designLayoutFieldValue } from "./design-layout-values";
import { readDesignComputedStyle } from "./design-style-values";

/** The value a select holds while the selected layers differ; its option is
 * disabled, so choosing it is impossible and it is never written. */
export const DESIGN_MIXED_VALUE = "mixed";

/** Whether a control shows "Mixed" for several selected layers: only when
 * every selected layer's details are loaded (one reading each) and the
 * readings differ. An unloaded layer could match, so it never makes a
 * control Mixed, and Mixed is never written: an edit sets every selected
 * layer to the new value. */
export function designValuesMixed(
  readings: readonly string[],
  selectedCount: number,
): boolean {
  if (selectedCount < 2 || readings.length !== selectedCount) return false;
  return readings.some((reading) => reading !== readings[0]);
}

/** The rule for one CSS property, or several read together (a paired field,
 * a fill's colour and image). */
export function designStyleMixed(
  loaded: readonly DesignRuntimeNodeDetails[],
  selectedCount: number,
  property: string | readonly string[],
): boolean {
  const properties = typeof property === "string" ? [property] : property;
  return designValuesMixed(
    loaded.map((node) =>
      properties
        .map((name) => readDesignComputedStyle(node.styles, name))
        .join("\u0000"),
    ),
    selectedCount,
  );
}

/** The rule for an inspector field, compared as the field shows it: geometry
 * as measured (X, Y, W, H, rotation), whole-number fields after rounding, and
 * a paired field across every property it edits. */
export function designFieldMixed(
  loaded: readonly DesignRuntimeNodeDetails[],
  selectedCount: number,
  property: string,
  options: {
    geometry?: boolean;
    whole?: boolean;
    linkedProperties?: readonly string[];
  } = {},
): boolean {
  const shown = (value: string) => {
    const number = Number.parseFloat(value);
    return options.whole && Number.isFinite(number)
      ? `${Math.round(number)}${value.replace(/^[-+]?[\d.]+/, "")}`
      : value;
  };
  return designValuesMixed(
    loaded.map((node) =>
      options.geometry
        ? shown(designLayoutFieldValue(node, property))
        : [property, ...(options.linkedProperties ?? [])]
            .map((name) => shown(readDesignComputedStyle(node.styles, name)))
            .join("\u0000"),
    ),
    selectedCount,
  );
}

/** A select's value and options: Mixed (disabled) first when mixed. */
export function designMixedSelect<T extends string>(
  mixed: boolean,
  value: T,
  options: readonly InspectorOption<T>[],
): { value: T | typeof DESIGN_MIXED_VALUE; options: readonly InspectorOption<string>[] } {
  return mixed
    ? {
        value: DESIGN_MIXED_VALUE,
        options: [{ value: DESIGN_MIXED_VALUE, label: "Mixed", disabled: true }, ...options],
      }
    : { value, options };
}

/** A segmented control's value: no segment is pressed while mixed. */
export function designMixedSegment<T extends string>(
  mixed: boolean,
  value: T,
): T | null {
  return mixed ? null : value;
}
