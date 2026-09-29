// ──────────────────────────────────────────────────────────
// Gibberish thinking — what the agent says it's doing, misspelled
// ──────────────────────────────────────────────────────────
//
// Settings → Experimental → "Gibberish agent thinking" puts these on the
// active turn's rail, between the glass square and the working timer
// (ActivityShimmer), shimmering, a new one every three seconds. A hundred
// agent-at-work phrases of up to three words, each misspelled so it still
// reads, and sounds, like itself: every word keeps its first consonant (a
// word that starts on a vowel may swap it) and about its length, and the
// vowels wander.
//
// A turn goes through all hundred in its own order (shuffled from its start
// time) before any comes round again, so no phrase shows twice in a row, and
// a remounted rail says what it would have said anyway.
// ──────────────────────────────────────────────────────────

/** [the phrase, its gibberish]. Only the gibberish is shown. */
export const GIBBERISH_THINKING: ReadonlyArray<readonly [phrase: string, gibberish: string]> = [
  ["Thinking", "Thenkeng"],
  ["Working too hard", "Wurkong tuu herd"],
  ["Planning", "Plunneng"],
  ["Pondering", "Pundereng"],
  ["Reasoning", "Reezuneng"],
  ["Cooking", "Cuukeng"],
  ["Brewing ideas", "Bruweng eydeaz"],
  ["Crunching numbers", "Crunchong numbahs"],
  ["Connecting dots", "Conneckteng duts"],
  ["Figuring it out", "Figgereng et oot"],
  ["Mulling it over", "Mulleng et uvah"],
  ["Digging deeper", "Deggeng deepah"],
  ["Reading the code", "Reedeng thu cude"],
  ["Writing code", "Wryteng cude"],
  ["Refactoring", "Reefucturang"],
  ["Debugging", "Deebuggeng"],
  ["Tracing bugs", "Treceng bugz"],
  ["Squashing bugs", "Squushang bugz"],
  ["Tinkering", "Tenkereng"],
  ["Noodling", "Nuudleng"],
  ["Scheming", "Skeemeng"],
  ["Plotting", "Pluttong"],
  ["Strategizing", "Stratejyzeng"],
  ["Calculating", "Calkyulateng"],
  ["Computing", "Compyooteng"],
  ["Processing", "Prucesseng"],
  ["Analyzing", "Anelyzeng"],
  ["Researching", "Reesurcheng"],
  ["Exploring", "Explureng"],
  ["Investigating", "Envestegateng"],
  ["Searching", "Surcheng"],
  ["Scanning files", "Scunneng fylez"],
  ["Sifting through", "Seftong thruu"],
  ["Untangling", "Untungleng"],
  ["Weaving logic", "Weeveng lojik"],
  ["Sketching ideas", "Sketcheng eydeaz"],
  ["Drafting", "Druffteng"],
  ["Polishing", "Pulesheng"],
  ["Tidying up", "Tydeeng ap"],
  ["Organizing", "Orgunyzeng"],
  ["Assembling", "Asembleng"],
  ["Crafting", "Cruffteng"],
  ["Forging ahead", "Furjeng uhed"],
  ["Hammering away", "Hummereng uwey"],
  ["Hustling", "Hussleng"],
  ["Juggling tasks", "Juggleng tasx"],
  ["Multitasking", "Multeetaskeng"],
  ["Deep in thought", "Deap en thawt"],
  ["Lost in thought", "Lawst en thawt"],
  ["Daydreaming", "Deydreemeng"],
  ["Contemplating", "Contimplateng"],
  ["Deliberating", "Deleberateng"],
  ["Musing", "Myuzeng"],
  ["Brainstorming", "Braynstormeng"],
  ["Cogitating", "Cogetateng"],
  ["Ruminating", "Ruumenateng"],
  ["Churning", "Chorneng"],
  ["Whirring", "Whurreng"],
  ["Humming along", "Hummeng ulong"],
  ["Buzzing", "Buzzeng"],
  ["Spinning up", "Spenneng ap"],
  ["Warming up", "Wurmeng ap"],
  ["Getting there", "Gettong thur"],
  ["Almost there", "Olmust thur"],
  ["Hold tight", "Huld tyte"],
  ["On it", "Un et"],
  ["Making magic", "Mukeng mujic"],
  ["Conjuring", "Conjerong"],
  ["Wizarding", "Wezzurdeng"],
  ["Casting spells", "Casteng spulls"],
  ["Summoning", "Sammuneng"],
  ["Decoding", "Deecudeng"],
  ["Deciphering", "Deseffereng"],
  ["Solving puzzles", "Sulveng puzzulz"],
  ["Cracking it", "Crakkeng et"],
  ["Piecing together", "Peeceng tugethah"],
  ["Mapping it out", "Muppeng et oot"],
  ["Navigating", "Nuvegateng"],
  ["Optimizing", "Uptemyzeng"],
  ["Tweaking", "Tweekeng"],
  ["Fine-tuning", "Fyne-tyuneng"],
  ["Double-checking", "Dubble-checkeng"],
  ["Verifying", "Vereefyeng"],
  ["Reviewing", "Reevyueng"],
  ["Proofreading", "Pruufreedeng"],
  ["Summarizing", "Summuryzeng"],
  ["Wrapping up", "Wruppeng ap"],
  ["Finishing touches", "Fenishong tachez"],
  ["Percolating", "Purculateng"],
  ["Simmering", "Semmereng"],
  ["Marinating", "Murenateng"],
  ["Hatching plans", "Hetcheng plunz"],
  ["Vibing", "Vybeng"],
  ["Pushing pixels", "Pusheng pexulz"],
  ["Reticulating splines", "Retekyulateng splynz"],
  ["Rubber ducking", "Rubbah dukkeng"],
  ["Consulting the oracle", "Consaltong thu orukle"],
  ["Channeling genius", "Chunneleng geenius"],
  ["Flipping bits", "Fleppeng betz"],
  ["Gathering context", "Gethereng contixt"],
];

/** A new phrase every… */
export const GIBBERISH_THINKING_MS = 3000;

/** Recent turns' orders through the phrases, so a ticking rail never
 *  reshuffles. Bounded: the oldest falls out. */
const orders = new Map<number, number[]>();
const ORDERS_KEPT = 8;

/** A turn's order through the phrases: a shuffle seeded by its start time. */
function orderFor(seed: number): number[] {
  const kept = orders.get(seed);
  if (kept) return kept;
  let state = Math.imul(seed ^ (seed >>> 16), 0x45d9f3b) >>> 0;
  const random = () => {
    // mulberry32
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const order = GIBBERISH_THINKING.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  orders.set(seed, order);
  if (orders.size > ORDERS_KEPT) {
    const oldest = orders.keys().next().value;
    if (oldest !== undefined) orders.delete(oldest);
  }
  return order;
}

/** The phrase a turn shows at `step`, its count of GIBBERISH_THINKING_MS
 *  since it started. `seed` is the turn's start time. The same turn and step
 *  always show the same phrase. */
export function gibberishThinking(seed: number, step = 0): string {
  const order = orderFor(Math.floor(seed) | 0);
  const at = ((Math.floor(step) % order.length) + order.length) % order.length;
  return GIBBERISH_THINKING[order[at]][1];
}
