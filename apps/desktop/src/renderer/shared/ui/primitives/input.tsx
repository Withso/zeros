import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/renderer/shared/ui/cn";
import { FIELD_BOX, FIELD_FOCUS, FIELD_INVALID } from "./field";

const inputVariants = cva(
  cn(
    "flex w-full min-w-0 px-2 placeholder:text-fg3 read-only:bg-bg2 read-only:text-fg2 file:border-0 file:bg-transparent file:text-xs file:font-medium file:text-fg1",
    FIELD_BOX,
    FIELD_FOCUS,
    FIELD_INVALID,
  ),
  {
    variants: {
      // Standard is 28px like Button and the Select trigger; compact is the
      // 24px field for inspectors and tables.
      size: { standard: "h-7", compact: "h-6" },
      // Inline is the rename look: no resting edge and a hover fill, so the
      // text reads as text until it is being edited.
      appearance: {
        outline: "",
        inline:
          "rounded-sm border-transparent px-1.5 hover:border-transparent hover:bg-bg2-highlight focus-visible:data-[zeros-keyboard-focus]:bg-bg1",
      },
      mono: { true: "font-mono text-3xxs", false: "" },
    },
    defaultVariants: { size: "standard", appearance: "outline", mono: false },
  },
);

export interface InputProps
  extends Omit<React.ComponentProps<"input">, "size">,
    VariantProps<typeof inputVariants> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, size, appearance, mono, ...props }, ref) => (
    <input
      type={type}
      className={cn(inputVariants({ size, appearance, mono }), className)}
      ref={ref}
      {...props}
    />
  ),
);
Input.displayName = "Input";

export { Input, inputVariants };
