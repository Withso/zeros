import * as React from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";

import { cn } from "@/renderer/shared/ui/cn";

const Switch = React.forwardRef<
  React.ComponentRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    className={cn(
      // On (checked): --switch-on-bg, the brown accent (--brown-fg) in every
      // theme. Off (unchecked): subtle border3 track with a 1px border4 ring
      // that lifts to fg3 on hover, like Checkbox and Radio. The border stays
      // transparent when checked so the track doesn't resize. Keyboard focus
      // swaps the ring for the opaque highlighted-bright core
      // (`not-focus-visible` keeps the unchecked ring from overriding it).
      // Both switch tokens live in styles/semantic-tokens.css.
      "peer focus-visible:ring-highlighted-bright/50 focus-visible:border-highlighted-bright data-[state=unchecked]:bg-border3 data-[state=unchecked]:not-focus-visible:border-border4 data-[state=unchecked]:not-focus-visible:enabled:hover:border-fg3 inline-flex h-5 w-8 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors focus-visible:ring-[3px] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-[var(--switch-on-bg)]",
      className,
    )}
    {...props}
    ref={ref}
  >
    <SwitchPrimitive.Thumb
      className={cn(
        // --switch-thumb: near-black on Dark's salmon ON track (8.5:1) and
        // pure white on Light's mauve one; one colour across ON/OFF. Its one
        // soft shadow is --switch-thumb-shadow: --shadow-dropdown's 24px blur
        // is wrong for a 16px thumb.
        "pointer-events-none block h-4 w-4 rounded-full bg-[var(--switch-thumb)] shadow-[var(--switch-thumb-shadow)] ring-0 transition-transform data-[state=checked]:translate-x-[14px] data-[state=unchecked]:translate-x-0",
      )}
    />
  </SwitchPrimitive.Root>
));
Switch.displayName = SwitchPrimitive.Root.displayName;

export { Switch };
