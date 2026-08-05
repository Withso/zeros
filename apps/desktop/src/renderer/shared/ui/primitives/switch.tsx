import * as React from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";

import { cn } from "@/renderer/shared/ui/cn";

const Switch = React.forwardRef<
  React.ComponentRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    className={cn(
      // On (checked): the inverted fill — same polarity-flipping surface as the
      // primary button (near-white on dark, near-black on light). Off (unchecked):
      // border3 track with a 1px border4 ring. Knob is bg3 in both states (see
      // Thumb) — it reads dark-on-light in dark mode, white-on-dark in light. The
      // border stays transparent when checked so the track doesn't resize.
      "peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-highlighted-bright/50 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-inverted-bg data-[state=unchecked]:bg-border3 data-[state=unchecked]:border-border4",
      className,
    )}
    {...props}
    ref={ref}
  >
    <SwitchPrimitive.Thumb
      className={cn(
        // bg3 fill + stock shadow are intentional: the thumb rides the
        // INVERTED track — near-white bg3 on a dark track in light, dark on
        // light in dark — so the "no bg3 on lower surfaces" rule doesn't
        // apply, and --shadow-dropdown's 24px blur is wrong for a 16px thumb.
        // check:ui ignore-next (inverted-track thumb — see above)
        "pointer-events-none block h-4 w-4 rounded-full bg-bg3 shadow-lg ring-0 transition-transform data-[state=checked]:translate-x-[18px] data-[state=unchecked]:translate-x-0",
      )}
    />
  </SwitchPrimitive.Root>
));
Switch.displayName = SwitchPrimitive.Root.displayName;

export { Switch };
