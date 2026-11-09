/** The transcript's fade into its pane above the top of the composer stack:
 *  one 32px dissolve that starts at the edge of the composer or the topmost
 *  card. The chat's dock column carries it for the cards in its flow; a docked
 *  picker is portaled, so PopoverContent surface="composer" carries its own.
 *  Inside that portal --pane-bg is :root's bg1, which matches because a picker
 *  only opens in the focused pane. 32px equals the transcript's pb-8, so the
 *  last line at rest stays clear. */
export const COMPOSER_DOCK_FADE =
  "pointer-events-none absolute inset-x-0 bottom-full h-8 bg-gradient-to-t from-(--pane-bg) to-transparent";
