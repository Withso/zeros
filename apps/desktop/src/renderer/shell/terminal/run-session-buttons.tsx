import { Globe, Square } from "lucide-react";
import { Button, Tooltip } from "../../shared/ui/primitives";
import { cn } from "../../shared/ui/cn";

/** Headers show labels while their own container has room; sidebar rows always
 * use compact icons. Both placements share the same actions and accessible names. */
export function RunSessionButtons({
  title,
  previewUrl,
  showLabels = false,
  onOpenPreview,
  onStop,
}: {
  title: string;
  previewUrl?: string | null;
  showLabels?: boolean;
  onOpenPreview(): void;
  onStop(): void;
}) {
  // The cache supplies normalized HTTP(S) URLs; display their effective port.
  const preview = previewUrl ? new URL(previewUrl) : null;
  const port = preview
    ? preview.port || (preview.protocol === "https:" ? "443" : "80")
    : null;
  const buttonClass = cn(
    "bg-bg1 text-fg1 shrink-0 gap-1.5 text-xs [&_svg]:size-3.5",
    showLabels &&
      "@[480px]/terminal-header:w-auto @[480px]/terminal-header:px-2",
  );
  const labelClass = "hidden @[480px]/terminal-header:inline";
  return (
    <div
      className="flex shrink-0 items-center gap-1"
      role="group"
      aria-label={`${title} run controls`}
    >
      <Tooltip
        label={
          previewUrl
            ? `Open ${previewUrl} in Browser`
            : "Waiting for a local preview address"
        }
      >
        <span className="inline-flex">
          <Button
            variant="secondary"
            size="icon-sm"
            aria-label={`Open ${title} in Browser`}
            disabled={!previewUrl}
            onClick={onOpenPreview}
            className={buttonClass}
          >
            <Globe className="text-fg1 size-3.5" aria-hidden />
            {showLabels && (
              <>
                <span className={labelClass}>Open</span>
                {port && (
                  <span className={cn("tabular-nums", labelClass)}>
                    :{port}
                  </span>
                )}
              </>
            )}
          </Button>
        </span>
      </Tooltip>
      <Tooltip label={`Stop ${title}`}>
        <Button
          variant="secondary"
          size="icon-sm"
          aria-label={`Stop ${title}`}
          onClick={onStop}
          className={buttonClass}
        >
          <Square className="text-fg1 size-3.5 fill-current" aria-hidden />
          {showLabels && <span className={labelClass}>Stop</span>}
        </Button>
      </Tooltip>
    </div>
  );
}
