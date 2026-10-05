import { z } from "zod";

/** Names are provider labels; full identities remain in the operation journal.
 * B7 accepts at most 62 lowercase ASCII characters with the zeros-v2- prefix. */
export function computerTemplateBuilderName(
  id: string,
  prefix = "zeros-v2-cc",
): string {
  const shortId = z
    .string()
    .uuid()
    .parse(id)
    .replaceAll("-", "")
    .toLowerCase()
    .slice(0, 16);
  const boundedPrefix = z
    .string()
    .max(128)
    .regex(/^zeros-v2-[a-z0-9][a-z0-9-]*$/)
    .parse(prefix)
    .slice(0, 45);
  return `${boundedPrefix}-${shortId}`;
}
