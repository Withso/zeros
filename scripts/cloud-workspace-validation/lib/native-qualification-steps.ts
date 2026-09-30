import { createHash, randomBytes } from "node:crypto";

const WORDS = [
  "amber", "anchor", "apple", "arbor", "aspen", "atlas", "basil", "beacon", "birch", "bloom", "breeze", "brook",
  "canyon", "cedar", "citrus", "clover", "cobalt", "comet", "copper", "coral", "cotton", "crimson", "dune", "ember",
  "fable", "fern", "fjord", "garnet", "glacier", "harbor", "hazel", "heron", "indigo", "island", "ivory", "juniper",
  "lagoon", "lantern", "laurel", "lilac", "linen", "maple", "meadow", "mesa", "mint", "nectar", "oasis", "olive",
  "orchid", "pebble", "pine", "prairie", "quartz", "raven", "ridge", "saffron", "sage", "sierra", "spruce", "tidal",
  "tulip", "velvet", "willow", "zephyr",
];

/** A unique value a model will repeat verbatim. A prefix plus hex reads as a
 * credential, which a provider may withhold, so replay checks would depend on
 * model policy instead of on the redactor they qualify. */
export function qualificationPhrase(random: (size: number) => Buffer = randomBytes): string {
  const bytes = random(8);
  return [...Array.from(bytes.subarray(0, 6), byte => WORDS[byte % WORDS.length]), bytes.readUInt16BE(6)].join("-");
}

/** Claude streams a fork destination's native binding after its first turn;
 * Codex and Cursor return it when the session starts. The source binding must
 * never stand in for the destination's. */
export function forkDestinationBinding<T>(streamed: T | undefined, started: T | undefined): T | undefined {
  return streamed ?? started;
}

/** Detects a secret's raw occurrence once per turn, including when a provider
 * streams it across message chunks: replay checks must prove redaction of
 * what the model actually emitted, not of any single notification. */
export function rawSecretObserver(secret: string) {
  let text = "", seen = false;
  return {
    observe(notification: unknown): boolean {
      if (seen) return false;
      const update = (notification as { update?: { sessionUpdate?: unknown; content?: { type?: unknown; text?: unknown } } } | null)?.update;
      if (update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text" && typeof update.content.text === "string")
        text = (text + update.content.text).slice(-(secret.length + 65536));
      seen = JSON.stringify(notification).includes(secret) || text.includes(secret);
      return seen;
    },
    reset() { text = ""; seen = false; },
  };
}

/** A failed run reports fixed-format identifiers only: an error code such as
 * EROFS (from the error or its causes), the error's class name, and an agent
 * failure's kind, stage and exit code, plus a truncated message digest.
 * Messages, stacks and stderr can carry prompt or provider text and are never
 * included. */
export function failureSignature(error: unknown): { code?: string; name?: string; kind?: string; stage?: string; exitCode?: number; messageSha256?: string } {
  const signature: { code?: string; name?: string; kind?: string; stage?: string; exitCode?: number; messageSha256?: string } = {};
  for (let current: unknown = error, depth = 0; current && typeof current === "object" && depth < 4 && !signature.code; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(code)) signature.code = code;
    current = (current as { cause?: unknown }).cause;
  }
  const value = error as { name?: unknown; kind?: unknown; stage?: unknown; failure?: { kind?: unknown; stage?: unknown; exit?: { code?: unknown } } } | null;
  if (typeof value?.name === "string" && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(value.name)) signature.name = value.name;
  const label = (candidate: unknown) => typeof candidate === "string" && /^[a-z][a-z0-9-]{1,40}$/.test(candidate) ? candidate : undefined;
  const kind = label(value?.failure?.kind) ?? label(value?.kind), stage = label(value?.failure?.stage) ?? label(value?.stage);
  if (kind) signature.kind = kind;
  if (stage) signature.stage = stage;
  const exit = value?.failure?.exit?.code;
  if (Number.isInteger(exit) && (exit as number) >= -256 && (exit as number) <= 256) signature.exitCode = exit as number;
  // Engine messages are fixed strings; a truncated digest matches one offline
  // without carrying any text that could hold provider output.
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message === "string" && message.length <= 512) signature.messageSha256 = createHash("sha256").update(message).digest("hex").slice(0, 16);
  return signature;
}
