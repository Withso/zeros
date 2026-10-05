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
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, options.maxLength);
  if (options.trimTrailingHyphens) slug = slug.replace(/-+$/g, "");
  return slug || options.fallback;
}
