import { PenTool, X } from "lucide-react";
import { Button } from "../../shared/ui";

export function ComposerDesignTag({ onRemove }: { onRemove(): void }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      type="button"
      onClick={onRemove}
      aria-label="Remove Design mode"
      data-composer-design-tag=""
      className="bg-brown-bg text-brown-fg hover:bg-brown-bg hover:text-brown-fg shrink-0 gap-1 rounded-md px-2 text-xs"
    >
      <PenTool size={12} />
      <span>Design</span>
      <X size={12} aria-hidden="true" />
    </Button>
  );
}
