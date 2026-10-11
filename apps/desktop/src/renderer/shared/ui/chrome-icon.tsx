import { createLucideIcon } from "lucide-react";

// Lucide's current package omits brand icons. Keep the approved monochrome
// Chrome glyph on the same icon primitive and geometry as transcript tools.
export const ChromeIcon = createLucideIcon("Chrome", [
  ["circle", { cx: "12", cy: "12", r: "10", key: "outer" }],
  ["circle", { cx: "12", cy: "12", r: "4", key: "inner" }],
  ["path", { d: "M21.17 8H12", key: "top" }],
  ["path", { d: "M3.95 6.06 8.5 14", key: "left" }],
  ["path", { d: "m10.88 21.94 4.58-7.94", key: "bottom" }],
]);
