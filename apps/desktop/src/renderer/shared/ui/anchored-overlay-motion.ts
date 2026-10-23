// An anchor can disappear in the same commit that closes its popup: hover-only
// actions hide, a selected row is replaced, or a retained owner becomes inert.
// Radix Presence otherwise keeps the popup and its positioner alive for an exit
// animation, which can then measure a zero-sized anchor and paint at (0, 0).
// Close at once, including force-mounted content. Only entry animates; dialogs
// and sheets have independent viewport geometry and keep their own motion.
export const ANCHORED_OVERLAY_MOTION =
  "animate-in fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:hidden data-[state=closed]:animate-none motion-reduce:animate-none";
