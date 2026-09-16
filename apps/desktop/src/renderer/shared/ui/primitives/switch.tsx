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
      // theme. Off (unchecked): border3 track with a 1px border4 ring. The
      // border stays transparent when checked so the track doesn't resize.
      // Both switch tokens live in styles/semantic-tokens.css.
      "peer focus-visible:ring-highlighted-bright/50 data-[state=unchecked]:bg-border3 data-[state=unchecked]:border-border4 inline-flex h-5 w-8 shrink-0 cursor-pointer items-center rounded-full border border-transparent shadow-sm transition-colors focus-visible:ring-[3px] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-[var(--switch-on-bg)]",
      className,
    )}
    {...props}
    ref={ref}
  >
    <SwitchPrimitive.Thumb
      className={cn(
        // --switch-thumb: a white-ish knob in every theme (near-white
        // --inverted-bg on dark, pure-white --inverted-fg in Light) so it reads
        // against both the brown ON track and the border3 OFF track. The stock
        // shadow is intentional: --shadow-dropdown's 24px blur is wrong for a
        // 16px thumb.
        // check:ui ignore-next (stock shadow on the 16px thumb — see above)
        "pointer-events-none block h-4 w-4 rounded-full bg-[var(--switch-thumb)] shadow-lg ring-0 transition-transform data-[state=checked]:translate-x-[14px] data-[state=unchecked]:translate-x-0",
      )}
    />
  </SwitchPrimitive.Root>
));
Switch.displayName = SwitchPrimitive.Root.displayName;

export { Switch };
