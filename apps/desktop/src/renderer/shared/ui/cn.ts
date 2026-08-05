// ============================================================
// cn — class-name joiner used by every primitive.
// Mirrors the shadcn/ui convention: compose class strings with
// clsx, then dedupe-merge Tailwind utilities with tailwind-merge.
// Both packages are already in the project (see package.json).
//
// twMerge is extended with the app's custom type-scale steps
// (zeros-tokens.css: text-xxs 10px, text-2xxs 11px, text-3xxs
// 12px). Without this, tailwind-merge can't classify them as
// font sizes, files them in the text-COLOR group, and silently
// drops them whenever the same cn() call also sets a text color
// (e.g. `text-2xxs text-fg2` → `text-fg2`).
// ============================================================
import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["xxs", "2xxs", "3xxs"] }],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
