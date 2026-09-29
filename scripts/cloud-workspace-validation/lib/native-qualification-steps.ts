import { randomBytes } from "node:crypto";

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
