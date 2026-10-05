export function designTitleSlug(
  title: string,
  options: {
    maxLength: number;
    fallback: string;
    trimTrailingHyphens?: boolean;
  },
): string {
  let slug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");
  if (slug.startsWith("-")) slug = slug.slice(1);
  if (slug.endsWith("-")) slug = slug.slice(0, -1);
  slug = slug.slice(0, options.maxLength);
  if (options.trimTrailingHyphens && slug.endsWith("-"))
    slug = slug.slice(0, -1);
  return slug || options.fallback;
}
