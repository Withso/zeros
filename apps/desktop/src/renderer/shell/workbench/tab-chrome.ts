// Shared chrome for both workbench tab rows. Keeping the geometry and selected
// states in one place prevents the terminal row from drifting visually from
// the Changes / Review / Files row above it. Both rows are sticky tab strips
// (use-sticky-tab-strip.tsx), which dictates two rules encoded here:
//
//   - Hover fills key off `data-[hovered=true]` (set by the strip's pointer
//     re-hit-testing), NOT `:hover` — native hover goes stale while the lane
//     scrolls under a stationary cursor. `transition-none` keeps the retarget
//     compositor-synced during a fling.
//   - The ACTIVE pill is CSS-sticky and pins to the lane edge it reaches; its
//     left-1/right-1 insets mirror the hook's EDGE_INSET_PX, and its opaque
//     bg-bg2 fill is what lets it float above scrolling neighbors (z-20 sits
//     above the strip's fades at z-10).

export const WORKBENCH_TAB_PILL_BASE_CLS =
  "relative flex h-7 shrink-0 cursor-pointer items-center overflow-hidden rounded-md text-xs font-medium transition-none";

export const WORKBENCH_TAB_PILL_ACTIVE_CLS =
  "bg-bg2 text-fg1 sticky left-1 right-1 z-20";

export const WORKBENCH_TAB_PILL_INACTIVE_CLS =
  "text-fg2 data-[hovered=true]:bg-bg2 data-[hovered=true]:text-fg1";
