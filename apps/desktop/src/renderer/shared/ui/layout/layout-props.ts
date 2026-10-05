import type * as React from "react";

export type LayoutElement =
  | "div"
  | "span"
  | "section"
  | "ul"
  | "li"
  | "nav"
  | "header"
  | "footer";

export interface LayoutProps extends React.HTMLAttributes<HTMLElement> {
  as?: LayoutElement;
  gap?: 0 | 0.5 | 1 | 1.5 | 2 | 2.5 | 3 | 4 | 6 | 8;
  align?: "start" | "center" | "end" | "stretch" | "baseline";
  justify?: "start" | "center" | "end" | "between" | "around" | "evenly";
  wrap?: boolean;
}

// Complete candidates keep the compiler and policy checks aware of every step.
const GAP_CLASSES = {
  0: "gap-0",
  0.5: "gap-0.5",
  1: "gap-1",
  1.5: "gap-1.5",
  2: "gap-2",
  2.5: "gap-2.5",
  3: "gap-3",
  4: "gap-4",
  6: "gap-6",
  8: "gap-8",
} as const;

const ALIGN_CLASSES = {
  start: "items-start",
  center: "items-center",
  end: "items-end",
  stretch: "items-stretch",
  baseline: "items-baseline",
} as const;

const JUSTIFY_CLASSES = {
  start: "justify-start",
  center: "justify-center",
  end: "justify-end",
  between: "justify-between",
  around: "justify-around",
  evenly: "justify-evenly",
} as const;

export function layoutClasses({ gap, align, justify, wrap }: LayoutProps) {
  return [
    gap === undefined ? undefined : GAP_CLASSES[gap],
    align === undefined ? undefined : ALIGN_CLASSES[align],
    justify === undefined ? undefined : JUSTIFY_CLASSES[justify],
    wrap === undefined ? undefined : wrap ? "flex-wrap" : "flex-nowrap",
  ];
}
