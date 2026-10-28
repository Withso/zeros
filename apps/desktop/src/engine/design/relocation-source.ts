import { parse } from "parse5";
import {
  designRelocationFlowStyles,
  designRelocationSchema,
  designRelocationStyles,
} from "@zeros/protocol/design-relocation";
import { validateDesignCssValue } from "@zeros/design-web";
import { elementRecords } from "./source";

/** A relocation moves authored markup to another parent or frame, where the
 * ordinary cascade applies to it as to any layer there: contextual
 * selectors, media queries and viewport units are the destination's to
 * resolve, exactly as in the source. What cannot travel is a component
 * instance inside the moving layer, whose definition is expanded per frame. */
export function assertDesignRelocationSource(
  source: string,
  nodeId: string,
): void {
  const moving = elementRecords(parse(source)).find(({ element }) =>
    element.attrs.some(({ name, value }) => name === "data-oid" && value === nodeId),
  )?.element;
  if (!moving) return;
  const pending = [moving];
  while (pending.length) {
    const element = pending.pop()!;
    if (
      element.tagName.includes("-") ||
      element.attrs.some(({ name }) => name === "data-zid")
    )
      throw new Error(
        "This layer cannot be relocated safely: a component instance. Keep it in its current frame or detach the instance first.",
      );
    for (const child of element.childNodes)
      if ("tagName" in child) pending.push(child);
  }
}

function admittedRelocation(input: unknown) {
  const relocation = designRelocationSchema.parse(input);
  for (const [property, value] of Object.entries(relocation.inheritedStyles)) {
    validateDesignCssValue(property, value);
    if (value.toLowerCase().includes("url("))
      throw new Error("Inherited asset references cannot be relocated safely.");
  }
  return relocation;
}

export function designRelocationRootStyles(
  input: unknown,
): Record<string, string> {
  return designRelocationStyles(admittedRelocation(input));
}

/** The same admitted relocation joining a flex or grid drop slot. */
export function designRelocationFlowRootStyles(
  input: unknown,
  flow: Readonly<Record<string, string | null | undefined>>,
): Record<string, string> {
  const styles = designRelocationFlowStyles(admittedRelocation(input), flow);
  for (const [property, value] of Object.entries(styles))
    validateDesignCssValue(property, value);
  return styles;
}
