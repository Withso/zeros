import type { ChangedFile } from "./changes-parse";

/** Search only the displayed rows. The original scope remains authoritative for
 * selection, counts, Viewed navigation, and Git actions. Reuse unchanged rows
 * and sections so searching does not defeat their memoization. */
export function filterChangeSections<T extends { files: ChangedFile[] }>(
  sections: T[],
  search: string,
): T[] {
  const query = search.trim().toLowerCase();
  if (!query) return sections;
  const filtered: T[] = [];
  for (const section of sections) {
    const files = section.files.filter(
      (file) =>
        file.path.toLowerCase().includes(query) ||
        file.oldPath?.toLowerCase().includes(query),
    );
    if (files.length === section.files.length) filtered.push(section);
    else if (files.length > 0) filtered.push({ ...section, files });
  }
  return filtered.length === sections.length &&
    filtered.every((section, index) => section === sections[index])
    ? sections
    : filtered;
}
