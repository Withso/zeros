import { z } from "zod";

export const COMPUTER_NAMED_REF = /^boat-computer:([a-z0-9][a-z0-9-]{0,62})@sha256:([a-f0-9]{64})$/;
export type ComputerSnapshotChannel = "development" | "alpha" | "beta" | "production";

const COMPUTER_NAME = /^([a-z0-9][a-z0-9-]*)-(development|alpha|beta|production)-computer-v([1-9][0-9]{0,18})$/;

export function isComputerTemplateSnapshotName(name: string, channel: ComputerSnapshotChannel): boolean {
  const match = COMPUTER_NAME.exec(name);
  return name.length <= 63 && match?.[2] === channel && BigInt(match[3]!) <= 9223372036854775807n;
}

/** N comes from the channel's durable NO CYCLE sequence, across all orgs and
 * accounts. Never use a per-org build number: slugs can be renamed or reused.
 * Persist the name before provider I/O; an existing provider name is refused. */
export function computerTemplateSnapshotName(input: {
  organizationSlug: string; version: number | string; channel: ComputerSnapshotChannel;
}): string {
  const version = typeof input.version === "number"
    ? String(z.number().int().positive().safe().parse(input.version))
    : z.string().regex(/^[1-9][0-9]{0,18}$/).parse(input.version);
  if (BigInt(version) > 9223372036854775807n) throw new Error("Computer snapshot version exhausted");
  const channel = z.enum(["development", "alpha", "beta", "production"]).parse(input.channel);
  const tail = `-${channel}-computer-v${version}`;
  const slug = input.organizationSlug.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "org";
  return `${slug.slice(0, 63 - tail.length).replace(/-+$/g, "")}${tail}`;
}

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
