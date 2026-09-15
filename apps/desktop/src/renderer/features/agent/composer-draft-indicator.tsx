import { Pencil } from "lucide-react";
import { Tooltip } from "../../shared/ui/primitives/tooltip";

/** An informational mark, not another focusable control inside a tab. */
export function ComposerDraftIndicator() {
  return (
    <Tooltip label="Unsent draft" side="bottom">
      <span
        className="text-fg2 inline-flex size-3 shrink-0 items-center justify-center"
        role="img"
        aria-label="Unsent draft"
        data-composer-draft=""
      >
        <Pencil className="size-3" data-draft-icon="" aria-hidden="true" />
      </span>
    </Tooltip>
  );
}
