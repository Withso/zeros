import * as React from "react";
import * as SliderPrimitive from "@radix-ui/react-slider";

import { cn } from "@/renderer/shared/ui/cn";

// A 4px border3 track with an fg1 range, and a solid 14px fg1 thumb on a bg1
// ring: hover adds a soft halo, keyboard focus the standard ring outside the
// bg1 one. Disabled dims the whole slider, track included.
const THUMB =
  "block size-3.5 rounded-full bg-fg1 shadow-[0_0_0_2px_var(--bg1)] transition-shadow duration-120 ease-out outline-none hover:shadow-[0_0_0_2px_var(--bg1),0_0_0_6px_color-mix(in_srgb,var(--fg1)_14%,transparent)] focus-visible:shadow-[0_0_0_2px_var(--bg1),0_0_0_3px_var(--highlighted-bright),0_0_0_6px_color-mix(in_srgb,var(--highlighted-bright)_50%,transparent)]";

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
      <SliderPrimitive.Range className="bg-fg1 absolute h-full rounded-full" />
    </SliderPrimitive.Track>
    {(props.value ?? props.defaultValue ?? [0]).map((_, index) => (
      <SliderPrimitive.Thumb key={index} className={THUMB} aria-label={label} aria-valuetext={valueText} />
    ))}
  </SliderPrimitive.Root>
));
Slider.displayName = SliderPrimitive.Root.displayName;

export { Slider };
