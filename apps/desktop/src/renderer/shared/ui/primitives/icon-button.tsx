import * as React from "react";
import { Slot } from "@radix-ui/react-slot";

import { cn } from "@/renderer/shared/ui/cn";

export type IconButtonSize = "inline" | "compact" | "standard";

/** The size icon buttons take when they name none: Toolbar and PanelHeader
 *  provide the 28px tool size. */
export const IconButtonSizeContext = React.createContext<IconButtonSize | undefined>(undefined);

export interface IconButtonProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "aria-label"
> {
  label: string;
  /** The name is `label`. Declared so a dashed attribute that JSX would
   * otherwise accept unchecked (directly or through a wrapper's props) is a
   * type error instead of being replaced by `label`. */
  "aria-label"?: never;
  /** inline = 20px action embedded in rows and tabs (12px glyph, 4px corners);
   * compact = 24px action in a dense toolbar or section header (12px glyph);
   * standard = 28px chrome and toolbar action (14px glyph). Defaults to
   * standard inside a Toolbar or PanelHeader and inline elsewhere. */
  size?: IconButtonSize;
  /** What `aria-pressed` looks like: the neutral selected fill with no edge,
   * or the active tool of a toolbar in the selection blue. */
  pressedTone?: "toggle" | "tool";
  asChild?: boolean;
}

// One hover (bg2-highlight) on every surface: bg2-hover was 1.06:1 on raised
// surfaces. The glyph size belongs to the component, so it wins over sizes a
// caller puts on the icon.
const BASE =
  "inline-flex shrink-0 select-none items-center justify-center border border-transparent p-0 text-fg2 transition-colors duration-120 ease-out hover:bg-bg2-highlight hover:text-fg1 data-[state=open]:bg-bg2-highlight data-[state=open]:text-fg1 focus-visible:outline-none focus-visible:border-highlighted-bright focus-visible:ring-[3px] focus-visible:ring-highlighted-bright/50 disabled:pointer-events-none disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0";

const SIZE_CLASSES = {
  inline: "size-5 rounded-sm [&_svg]:size-3",
  compact: "size-6 rounded-md [&_svg]:size-3",
  standard: "size-7 rounded-md [&_svg]:size-3.5",
} as const;

// Selection is a fill a step above hover and never an edge.
const PRESSED_CLASSES = {
  toggle:
    "aria-pressed:bg-selected-bg aria-pressed:text-fg1 aria-pressed:hover:bg-selected-bg aria-pressed:hover:text-fg1",
  tool: "aria-pressed:bg-(--design-selection-label-bg) aria-pressed:text-(--design-selection-label-fg) aria-pressed:hover:bg-(--design-selection-label-bg) aria-pressed:hover:text-(--design-selection-label-fg)",
} as const;

/** Icon-only action with a required accessible name. asChild preserves link
 * semantics. */
const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  (
    {
      label,
      size,
      pressedTone = "toggle",
      asChild = false,
      type,
      className,
      ...props
    },
    ref,
  ) => {
    const Comp = asChild ? Slot : "button";
    const contextSize = React.useContext(IconButtonSizeContext);
    const resolvedSize = size ?? contextSize ?? "inline";
    return (
      <Comp
        {...props}
        ref={ref}
        type={asChild ? type : (type ?? "button")}
        aria-label={label}
        className={cn(
          BASE,
          SIZE_CLASSES[resolvedSize],
          PRESSED_CLASSES[pressedTone],
          className,
        )}
      />
    );
  },
);
IconButton.displayName = "IconButton";

export { IconButton };
