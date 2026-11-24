import * as React from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";

import { cn } from "@/renderer/shared/ui/cn";

const Switch = React.forwardRef<
  React.ComponentRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    className={cn(
      // On (checked): --switch-on-bg, the accent in every theme. Off
      // (unchecked): subtle border3 track with a 1px border4 ring that lifts
      // to fg3 on hover, like Checkbox and Radio. The border stays
      // transparent when checked so the track doesn't resize. Keyboard focus
      // is a 1px accent line one pixel off the track, so it still shows
      // around the accent fill. Both switch tokens live in
      // styles/semantic-tokens.css.
      "peer focus-visible:outline-accent data-[state=unchecked]:bg-border3 data-[state=unchecked]:border-border4 data-[state=unchecked]:enabled:hover:border-fg3 inline-flex h-5 w-8 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors focus-visible:outline-1 focus-visible:outline-offset-1 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-[var(--switch-on-bg)]",
      className,
    )}
    {...props}
    ref={ref}
  >
    <SwitchPrimitive.Thumb
      className={cn(
        // --switch-thumb: white in both themes, one colour across ON/OFF. Its one
        // soft shadow is --switch-thumb-shadow: --shadow-dropdown's 24px blur
        // is wrong for a 16px thumb.
        "pointer-events-none block h-4 w-4 rounded-full bg-[var(--switch-thumb)] shadow-[var(--switch-thumb-shadow)] ring-0 transition-transform data-[state=checked]:translate-x-[14px] data-[state=unchecked]:translate-x-0",
      )}
    />
  </SwitchPrimitive.Root>
));
Switch.displayName = SwitchPrimitive.Root.displayName;

export { Switch };
