/** Up to two initials for an avatar: the first character of each of the
 * first two words. A single handle-like word ("alex.rivera@acme.com",
 * "octo-cat") is read by its parts, an email by its local part only; a
 * hyphenated first name among other words stays one word. Whole characters,
 * so an emoji is never split; "·" when nothing is left. */
export function initialsOf(name: string | null | undefined): string {
  const source = (name ?? "").trim();
  let words = source.split(/\s+/).filter(Boolean);
  if (words.length === 1) {
    words = words[0]!.replace(/@.*$/, "").split(/[._-]+/).filter(Boolean);
  }
  const first = (word: string | undefined) => (word ? (Array.from(word)[0] ?? "") : "");
  return (first(words[0]) + first(words[1])).toUpperCase() || "·";
}
