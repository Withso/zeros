import type { MessageContentSegment } from "@zeros/protocol/agent-messages";

/** Trim trailing whitespace from the END of a sent user message's segments —
 *  only at the tail, never the middle. Trailing whitespace can span several
 *  text segments after serialization, so we walk back through them: trim each,
 *  drop any that become empty, and STOP at the first non-text segment (a
 *  mention / attachment pill is content, so whitespace before it is "in the
 *  middle" and stays). Leading + interior whitespace is preserved, so a blank
 *  line between paragraphs or a deliberate indent in the body is untouched.
 *  Returns the same array reference when there's nothing to trim. */
export function trimTrailingSegments(
  segments: MessageContentSegment[],
): MessageContentSegment[] {
  let end = segments.length;
  while (end > 0) {
    const seg = segments[end - 1];
    if (seg.type !== "text") break; // hit a pill — the tail is real content
    const trimmed = seg.text.trimEnd();
    if (trimmed === seg.text) break; // no trailing whitespace here — done
    if (trimmed.length === 0) {
      end -= 1; // wholly whitespace — drop it and keep walking back
      continue;
    }
    // Partially whitespace — keep the trimmed text and stop.
    return [...segments.slice(0, end - 1), { type: "text", text: trimmed }];
  }
  return end === segments.length ? segments : segments.slice(0, end);
}
