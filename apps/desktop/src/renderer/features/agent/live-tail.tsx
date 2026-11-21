// The live tail's composed motion. Nothing travels: when the agent's growth
// moves the loader line (or, pinned, the content above it) it is at its new
// place and settles the last few px. Rows, headers and messages that appear
// are simply there. When the turn ends the line is simply gone. The language
// lives in shared/ui/motion.

import { useLayoutEffect, useRef, type ReactNode } from "react";
import { createGlide, softEnter, type Glide } from "@/renderer/shared/ui/motion/soft-motion";

/** Wraps the live turn's loader line.
 * - `growth` changes when the agent's events changed (a call, a header, a
 *   message): the layout change that follows may settle. Anything else (a
 *   reader toggling a disclosure, a resize) lands in place.
 * - `reenterKey` changes when the line's call has been handed to the feed as
 *   a row: the line takes its new place, settling its last few px.
 * - `present` false (the turn ended, or it waits on the user): the line is
 *   simply gone, and every settle it started ends at once.
 * Inactive (hidden retained) surfaces do no motion. */
export function LiveTailLine({ present, active, growth, readerOwned = false, reenterKey, className, children }: {
  present: boolean;
  active: boolean;
  growth: unknown;
  /** The reader opened the live tail group: growth inside it lands in place. */
  readerOwned?: boolean;
  reenterKey?: string;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const glide = useRef<Glide | null>(null);

  // Shown again after the turn hid it (an answered permission or question):
  // it dissolves back in. The first appearance in a feed does not.
  const hidden = useRef(false);
  const wasPresent = useRef(present);
  useLayoutEffect(() => {
    // A surface hidden from view is not the turn hiding the line: no replay.
    if (!present && wasPresent.current && active) hidden.current = true;
    wasPresent.current = present;
    if (!present || !hidden.current || !ref.current || !active) return;
    hidden.current = false;
    softEnter(ref.current);
  }, [present, active]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !active || !present || !el.parentElement) return;
    glide.current = createGlide(el, el.parentElement);
    return () => {
      glide.current?.dispose();
      glide.current = null;
    };
  }, [active, present]);

  // Before `growth` below, so this commit's growth is judged with it.
  useLayoutEffect(() => { glide.current?.readerOwns(readerOwned); });

  const grown = useRef(growth);
  useLayoutEffect(() => {
    if (grown.current === growth) return;
    grown.current = growth;
    glide.current?.grew();
  }, [growth]);

  const reenter = useRef(reenterKey);
  useLayoutEffect(() => {
    if (reenter.current === reenterKey) return;
    reenter.current = reenterKey;
    const el = ref.current;
    if (!el || !active) return;
    // It now sits lower (under the row): it lands there, settling its last
    // few px, with the new label already on it.
    glide.current?.settle();
  }, [reenterKey, active]);

  if (!present) return null;
  return <div ref={ref} data-live-tail-line="" className={className}>{children}</div>;
}
