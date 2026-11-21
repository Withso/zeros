/** Characters that more than fill the description pill. */
export const THOUGHT_PREVIEW_FILL = 100;

/** The thought's opening line for its description pill, or undefined while
 * that line is not yet known. It depends only on the first
 * THOUGHT_PREVIEW_FILL characters and on whether they have all arrived, so
 * once set it never changes as the thought streams: the first line or
 * sentence once it is complete, else the first FILL characters once they
 * have arrived, else (the thought finished short) the whole text. */
export function thoughtPreview(text: string, finished: boolean): string | undefined {
  const head = text.slice(0, THOUGHT_PREVIEW_FILL);
  const start = head.search(/\S/);
  // A line break, or sentence punctuation followed by whitespace, ends the
  // opening line. A final "." may still become "..." or "3.5", so it only
  // counts once whitespace follows.
  const end = start < 0 ? null : /\n|[.!?](?=\s)/.exec(head.slice(start));
  let line: string | undefined;
  if (end) line = head.slice(start, start + end.index + (end[0] === "\n" ? 0 : 1));
  else if (text.length >= THOUGHT_PREVIEW_FILL) line = head;
  else if (finished) line = text;
  if (line === undefined) return undefined;
  const preview = line
    .replace(/\s+/g, " ")
    .trim()
    // Reasoning summaries often open with a bold title.
    .replace(/^(\*\*|__)(.+)\1$/, "$2");
  return preview || undefined;
}
