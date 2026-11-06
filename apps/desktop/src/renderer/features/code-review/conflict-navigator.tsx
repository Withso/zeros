import { ChevronDown, ChevronUp } from "lucide-react";
import { Tooltip } from "@/renderer/shared/ui/primitives";
import { IconButton } from "@/renderer/shared/ui/primitives/icon-button";

/** Previous and next conflict around "1 / 2", beside a file's name. It shows
 * only while blocks remain; the arrows wrap. */
export function ConflictNavigator({
  count,
  shown,
  onPrevious,
  onNext,
  disabled = false,
}: {
  count: number;
  shown: number;
  onPrevious: () => void;
  onNext: () => void;
  disabled?: boolean;
}) {
  if (count <= 0) return null;
  return (
    <div
      role="group"
      aria-label="Conflicts"
      className="border-border2 text-fg2 ml-1 inline-flex h-6 shrink-0 items-center gap-0.5 rounded-full border px-0.5 font-sans text-3xxs leading-4 tabular-nums"
    >
      <Tooltip label="Previous conflict">
        <IconButton
          size="inline"
          label="Previous conflict"
          className="rounded-full"
          disabled={disabled}
          onClick={onPrevious}
        >
          <ChevronUp />
        </IconButton>
      </Tooltip>
      <span className="px-1 whitespace-nowrap">
        <span className="text-fg1">{shown}</span> / {count}
      </span>
      <Tooltip label="Next conflict">
        <IconButton
          size="inline"
          label="Next conflict"
          className="rounded-full"
          disabled={disabled}
          onClick={onNext}
        >
          <ChevronDown />
        </IconButton>
      </Tooltip>
    </div>
  );
}
