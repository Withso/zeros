import * as React from "react";
import * as SliderPrimitive from "@radix-ui/react-slider";

import { cn } from "@/renderer/shared/ui/cn";

// A 4px border3 track with an fg1 range, and a solid 14px fg1 thumb on a 2px
// ring in the surface the slider sits on (--slider-ring, bg1 unless the host
// sets it, as the bg2 media island does), so it never draws a darker collar.
// No hover halo: like every other control, hover is quiet and keyboard focus
// is the 1px accent ring outside the surface one. Disabled dims the whole
// slider, track included.
const THUMB =
  "block size-3.5 rounded-full bg-fg1 shadow-[0_0_0_2px_var(--slider-ring,var(--bg1))] transition-shadow duration-fast ease-out outline-none focus-visible:shadow-[0_0_0_2px_var(--slider-ring,var(--bg1)),0_0_0_3px_var(--accent)]";

const Slider = React.forwardRef<
  React.ComponentRef<typeof SliderPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root> & {
    /** The thumb's accessible name; the thumb is what assistive tech reads. */
    label?: string;
    /** The value in words, e.g. "0:12 of 1:30", for values a number misreads. */
    valueText?: string;
  }
>(({ className, label, valueText, ...props }, ref) => (
  <SliderPrimitive.Root
    ref={ref}
    className={cn(
      "relative flex h-4 w-full touch-none select-none items-center data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      className,
    )}
    {...props}
  >
    <SliderPrimitive.Track className="bg-border3 relative h-1 w-full grow overflow-hidden rounded-full">
      <SliderPrimitive.Range className="bg-accent absolute h-full rounded-full" />
    </SliderPrimitive.Track>
    {(props.value ?? props.defaultValue ?? [0]).map((_, index) => (
      <SliderPrimitive.Thumb key={index} className={THUMB} aria-label={label} aria-valuetext={valueText} />
    ))}
  </SliderPrimitive.Root>
));
Slider.displayName = SliderPrimitive.Root.displayName;

export { Slider };
