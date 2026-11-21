// A tool's name and the description beside it, shared by every row of that
// shape. The description gives way first; the name truncates only once the
// description is down to its stub.

import { useRef, useState, type HTMLAttributes, type ReactNode } from "react";

import { cn } from "@/renderer/shared/ui/cn";
import { Tooltip } from "@/renderer/shared/ui/primitives";

/** Layout for whatever follows a tool name (preview chip, file tag, text).
 * The huge shrink factor makes it absorb the lane's shortfall before the
 * name. Its floor is a 48px stub, or its own width when that is shorter, so a
 * short preview is never padded out. */
export const TOOL_DESCRIPTION_FIT =
  "shrink-[9999] min-w-[calc-size(max-content,min(size,48px))]";

/** The tool name. `capped` (a description follows it) limits it to 22ch so
 * the description keeps the room; alone it may reach 60ch. A truncated name
 * shows itself in the shared tooltip. */
export function ToolName({
  label,
  capped,
  className,
  children,
  ...props
}: {
  label: string;
  capped: boolean;
  className?: string;
  children?: ReactNode;
} & Omit<HTMLAttributes<HTMLSpanElement>, "children">) {
  const ref = useRef<HTMLSpanElement>(null);
  const [hint, setHint] = useState(false);
  return (
    <Tooltip
      label={label}
      open={hint}
      onOpenChange={(open) => {
        const name = ref.current;
        setHint(open && !!name && name.scrollWidth > name.clientWidth);
      }}
    >
      <span
        {...props}
        ref={ref}
        className={cn(
          "min-w-0 truncate text-reading leading-5",
          capped ? "max-w-[22ch]" : "max-w-[60ch]",
          className,
        )}
      >
        {children ?? label}
      </span>
    </Tooltip>
  );
}

/** The collapsed row's description chip: 20px, 13/16 on bg2, the height and
 * size of the file tags it sits among. `className` carries a status tone. */
export function ToolPreview({
  mono,
  className,
  previewRef,
  children,
}: {
  mono?: boolean;
  className?: string;
  /** For a soft entrance when the description arrives after the row. */
  previewRef?: (el: HTMLElement | null) => void;
  children: ReactNode;
}) {
  return (
    <span
      ref={previewRef}
      data-tool-preview=""
      className={cn(
        "max-w-[440px] truncate rounded-sm px-1.5 py-0.5 text-xs leading-4 font-medium",
        TOOL_DESCRIPTION_FIT,
        mono && "font-mono",
        "bg-bg2 text-fg2",
        className,
      )}
    >
      {children}
    </span>
  );
}
