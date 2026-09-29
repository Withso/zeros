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
