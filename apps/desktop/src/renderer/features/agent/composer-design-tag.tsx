import { PenTool, X } from "lucide-react";
import { Pill } from "../../shared/ui/primitives";

/** The Design mode tag: the 24px control Pill in the mode tone. */
export function ComposerDesignTag({ onRemove }: { onRemove(): void }) {
  return (
    <Pill
      size="control"
      tone="mode"
      type="button"
      onClick={onRemove}
      aria-label="Remove Design mode"
      data-composer-design-tag=""
    >
      <PenTool aria-hidden="true" />
      <span data-composer-design-tag-label="">Design</span>
      <X aria-hidden="true" />
    </Pill>
  );
}
