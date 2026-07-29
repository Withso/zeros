// Workspace + branch naming.
//
//   1. workspaceId — short hex + kebab slug (`ws_8f3a2c-add-canvas-zoom`).
//      Short hex gives a stable DB key; the kebab slug makes the folder
//      legible in `pwd`/`ls`. Pure UUIDs are hostile in shells; pure names
//      collide. When no prompt hint is supplied, we fall back to a colour
//      name (`ws_8f3a2c-cream`) — see COLOURS dictionary below.
//
//   2. branch name — a colour, no random tail (`zeros/Cream`). Adopted
//      2026-07-29, replacing `zeros/<flower>-<4 hex>`. The hex tail existed
//      only to make collisions improbable; it made every workspace read as
//      `digitalis-02d3`. Uniqueness is now *allocated* rather than gambled
//      on: pickFreeColourName() is handed the set of names already used in
//      THIS repo and returns one that isn't. See allocation notes there.
//
//      Losing the tail means the name is no longer self-uniquifying, so the
//      DB carries a UNIQUE index on (repo_slug, branch) (migration 24) and
//      every caller retries on violation. Do not reintroduce a caller that
//      generates a name without consulting the used-set.
//
//      The agent / the renderer may later replace this auto name via
//      `workspace_propose_branch_name` (see rename-hook.ts).

import { randomBytes } from "node:crypto";

/** 350 single-word colour names, drawn from historic pigments and dyes,
 *  heraldic tinctures, traditional Japanese/Chinese colours, minerals, and a
 *  few modern paint coinages. See docs/color-names.md for the family + hex of
 *  each; this file only needs the names.
 *
 *  Invariants (enforced by naming.test.ts, and relied on elsewhere):
 *    - One capitalized word, 3-13 letters, `/^[A-Z][a-z]{2,15}$/`. No spaces
 *      or hyphens: the name becomes a branch AND a directory, and single
 *      words survive shell completion.
 *    - Unique under case folding. macOS filesystems are case-insensitive and
 *      git stores loose refs as files, so "Cream" and "cream" would collide
 *      on disk even though git treats them as distinct refs.
 *    - None collide with RESERVED_BRANCHES, case-insensitively.
 *  Sorted alphabetically for ease of editing. */
// The dense grid is deliberate: 350 names one-per-line is 350 lines of noise,
// and packing them lets you scan the alphabet visually when checking whether a
// name is already present. The directive must stay the LAST comment line before
// the declaration or prettier ignores it.
// prettier-ignore
const COLOURS = [
  "Absinthe", "Alabaster", "Alizarin", "Alloy", "Amaranth", "Amazonite",
  "Amber", "Amethyst", "Anthracite", "Apricot", "Aquamarine", "Argent",
  "Artichoke", "Asagi", "Ash", "Asparagus", "Aubergine", "Auburn",
  "Aureolin", "Australien", "Avocado", "Azure", "Battleship", "Beaver",
  "Beryl", "Bice", "Bisque", "Bistre", "Bittersweet", "Bitumen", "Blush",
  "Bole", "Bondi", "Bone", "Bottle", "Bronze", "Buff", "Burgundy",
  "Byzantine", "Byzantium", "Cadet", "Cadmium", "Cambridge", "Cameo",
  "Canary", "Capri", "Cardinal", "Carmine", "Carnation", "Carnelian",
  "Carolina", "Carrot", "Celadon", "Celadonite", "Celeste", "Cerise",
  "Cerulean", "Chalk", "Chamoisee", "Charcoal", "Charm", "Chartreuse",
  "Chestnut", "Chocolate", "Chrome", "Cinereous", "Cinnabar", "Cinnamon",
  "Citrine", "Citron", "Claret", "Cobalt", "Cochineal", "Coffee",
  "Copper", "Coquelicot", "Coral", "Coralline", "Corbeau", "Cordovan",
  "Cornflower", "Cramoisy", "Cream", "Crimson", "Cyanine", "Cyclamen",
  "Davy", "Delft", "Denim", "Drab", "Dun", "Ebony", "Eburnean", "Ecru",
  "Eggshell", "Egyptian", "Eigengrau", "Elephant", "Emerald", "Eminence",
  "Fallow", "Falu", "Fandango", "Fawn", "Feldgrau", "Fern",
  "Feuillemorte", "Filemot", "Flame", "Flamingo", "Flax", "Folly",
  "Forest", "Frostbite", "Fuchsine", "Fulvous", "Fuscous", "Gainsboro",
  "Gamboge", "Garnet", "Gentian", "Ginger", "Gingerline", "Glaucous",
  "Gofun", "Goldenrod", "Graphite", "Grenadine", "Gridelin", "Gunmetal",
  "Harlequin", "Heliotrope", "Hooker", "Humorous", "Hunter", "Icterine",
  "Imperial", "Impulsive", "Incarnadine", "Indanthrone", "Independence",
  "Indigo", "Iris", "Isabelline", "Ivory", "Jade", "Jaffa", "Jasmine",
  "Jasper", "Jet", "Jonquil", "Kachi", "Kariyasu", "Kelly", "Kermes",
  "Khaki", "Kihada", "Kingfisher", "Kohaku", "Kurotsurubami", "Lapis",
  "Laurel", "Lemon", "Liberty", "Licorice", "Lilac", "Linen", "Liver",
  "Loden", "Lust", "Madder", "Magnolia", "Maize", "Majorelle",
  "Malachite", "Mandarin", "Mantis", "Marengo", "Marigold", "Massicot",
  "Matcha", "Mauve", "Mauveine", "Maya", "Mikado", "Minium", "Mizu",
  "Mizuasagi", "Moegi", "Mole", "Momo", "Moonstone", "Mountbatten",
  "Mulberry", "Mummy", "Murrey", "Mustard", "Myrtle", "Mystic", "Nacarat",
  "Nadeshiko", "Naples", "Nattier", "Nero", "Nickel", "Obsidian", "Ochre",
  "Olive", "Olivine", "Onyx", "Opal", "Orchid", "Orpiment", "Otter",
  "Outerspace", "Oxblood", "Oxford", "Palatinate", "Parchment", "Payne",
  "Peachblow", "Peacock", "Pearl", "Periwinkle", "Perse", "Persian",
  "Persimmon", "Pervenche", "Pewter", "Phlox", "Piggy", "Pistachio",
  "Platinum", "Plum", "Ponceau", "Popinjay", "Poppy", "Powder",
  "Primrose", "Princeton", "Prussian", "Puce", "Pumpkin", "Purpureus",
  "Qinglian", "Quartz", "Quinacridone", "Raisin", "Razzmatazz", "Realgar",
  "Redwood", "Reseda", "Rhodamine", "Rose", "Rosewood", "Rubine", "Ruby",
  "Ruddle", "Rufous", "Ruri", "Rurikon", "Russet", "Russian", "Rust",
  "Sable", "Saffron", "Sakura", "Salmon", "Sanguine", "Sap", "Sapphire",
  "Sapphirine", "Sarcoline", "Scarlet", "Seal", "Seasalt", "Seiji",
  "Sepia", "Shamrock", "Shinbashi", "Shocking", "Sienna", "Silver",
  "Sinopia", "Sinople", "Skobeloff", "Slate", "Smalt", "Smaragdine",
  "Smoke", "Snow", "Snugglepuss", "Solferino", "Soot", "Sorairo", "Steel",
  "Straw", "Sulfur", "Sumi", "Tangelo", "Tangerine", "Taupe", "Tawny",
  "Tekhelet", "Thistle", "Thulian", "Tianqing", "Tiffany", "Timberwolf",
  "Titanium", "Titian", "Tokiwa", "Trout", "Turquoise", "Tuscan",
  "Tyrian", "Ube", "Uguisu", "Ultramarine", "Umber", "Vandyke",
  "Vantablack", "Vegas", "Vellum", "Verdigris", "Verditer", "Vermilion",
  "Veronica", "Viridian", "Walnut", "Wasabi", "Watchet", "Watermelon",
  "Wedgwood", "Weld", "Wenge", "Wheat", "Wine", "Wisteria", "Xanadu",
  "Xanthic", "Xanthous", "Yale", "Yamabuki", "Yinmn", "Zaffre",
  "Zibeline", "Zinc", "Zinnwaldite", "Zomp",
];

const SLUG_CLEAN_RE = /[^a-z0-9]+/g;
const SLUG_EDGE_RE = /^-+|-+$/g;
/** Accepts BOTH shapes that reach a branch: an allocated colour name
 *  ("Cream", "Cream-v2") and a prompt-derived slug ("add-canvas-zoom").
 *  Uppercase became legal on 2026-07-29 with the colour scheme — before
 *  that this was `/^[a-z][a-z0-9-]{2,48}$/`. Still deliberately stricter
 *  than git's own ref rules: no slashes, dots, or leading "-", so a branch
 *  name can never read as a path or a flag. */
const BRANCH_RE = /^[A-Za-z][A-Za-z0-9-]{2,48}$/;
/** Branch refs reserved by tooling — never accept these as user-proposed
 *  names. Compared case-insensitively (see isValidBranchName): "Main" must
 *  be rejected as firmly as "main". */
// prettier-ignore
const RESERVED_BRANCHES = new Set([
  "main", "master", "head", "trunk", "develop", "release", "staging",
  "production", "prod", "dev", "default",
]);

/** Generate a short workspace id like "ws_8f3a2c-add-canvas-zoom". The
 *  hex is the stable identity. The slug is a hint — if `hint` is empty
 *  or all non-alphanumeric, we fall back to a short adj-noun pair. */
export function generateWorkspaceId(hint?: string): string {
  const hex = randomBytes(3).toString("hex"); // 6 chars
  const slug = slugifyHint(hint);
  return `ws_${hex}-${slug}`;
}

function slugifyHint(hint: string | undefined): string {
  const raw = (hint ?? "").toLowerCase();
  const cleaned = raw
    .replace(SLUG_CLEAN_RE, "-")
    .replace(SLUG_EDGE_RE, "")
    .slice(0, 40);
  if (cleaned.length >= 3) return cleaned;
  // Fall back to a colour so the folder name never looks like
  // "ws_8f3a2c-" with a trailing dash from an empty slug. Lowercased: the
  // workspace id is a shell path component, not a display name.
  return randomColour().toLowerCase();
}

/** Same crypto-backed picker the branch allocator uses (randomIndex below).
 *  Not Math.random: this value is a component of the workspace ID, and that ID
 *  is what setupSessionId builds a PTY session identifier out of — so it is a
 *  name other parts of the engine treat as unguessable, not just cosmetic. */
function randomColour(): string {
  return COLOURS[randomIndex(COLOURS.length)];
}

/** The `zeros/` prefix marks a ref as workspace-owned (see
 *  pruneOrphanWorkspaceBranchOwnershipRefs). Branch = prefix + colour. */
export const BRANCH_PREFIX = "zeros/";

/** Strip the ownership prefix to get the display name: `zeros/Cream` →
 *  `Cream`. Non-prefixed refs (a user's own branch) pass through. */
export function branchDisplayName(branch: string): string {
  return branch.startsWith(BRANCH_PREFIX)
    ? branch.slice(BRANCH_PREFIX.length)
    : branch;
}

/** How many `-vN` rounds to try once all 350 base colours are taken. Each
 *  round is another full 350 names, so this ceiling is 35,350 workspaces in
 *  ONE repo — far past the point where a human would still be using it. */
const MAX_SUFFIX_ROUNDS = 100;

/** Pick a colour name not already used in this repo.
 *
 *  `usedNames` must be every name already claimed in the target repo, from
 *  ALL THREE authorities — DB rows (including archived ones; an archived
 *  "Cream" still owns the name), git refs under `zeros/`, and directory
 *  entries in the repo's workspace folder. Callers gather it in bulk; see
 *  collectUsedWorkspaceNames in worktree.ts. Names are compared
 *  case-insensitively, so pass whatever casing you have.
 *
 *  Allocation order, and why:
 *    1. A never-used colour, chosen at RANDOM from the free set. Random,
 *       not first-free, so successive workspaces don't march alphabetically
 *       ("Absinthe", "Alabaster", "Alizarin", …) — that reads like a counter
 *       and makes two workspaces easy to mix up.
 *    2. Only when all 350 are gone: `<Colour>-v1`, again from the free set,
 *       then `-v2`, and so on. Suffixing is a last resort — the whole point
 *       is that a workspace is called "Cream", not "Cream-v3". Sweeping N
 *       across the WHOLE dictionary before incrementing keeps suffixes as
 *       low and as evenly spread as possible.
 *
 *  Returns null only if the caller's repo somehow holds every name through
 *  MAX_SUFFIX_ROUNDS; callers surface that as a retryable error.
 *
 *  NOTE: this is a pure function over a snapshot. It cannot prevent two
 *  concurrent creates from being handed the same free set and picking the
 *  same name — that's what the UNIQUE index on (repo_slug, branch) is for.
 *  Callers MUST retry on constraint violation rather than trusting this. */
export function pickFreeColourName(usedNames: Iterable<string>): string | null {
  const used = new Set<string>();
  for (const n of usedNames) used.add(n.toLowerCase());
  const free = COLOURS.filter((c) => !used.has(c.toLowerCase()));
  if (free.length > 0) return free[randomIndex(free.length)];
  for (let round = 1; round <= MAX_SUFFIX_ROUNDS; round++) {
    const candidates = COLOURS.map((c) => `${c}-v${round}`).filter(
      (c) => !used.has(c.toLowerCase()),
    );
    if (candidates.length > 0)
      return candidates[randomIndex(candidates.length)];
  }
  return null;
}

/** Unbiased index in [0, n). Crypto-backed on two grounds: rejection sampling
 *  gives a genuinely uniform pick (the modulo of a 32-bit draw does not), and
 *  one caller — randomColour, via generateWorkspaceId — feeds a workspace ID
 *  that setupSessionId turns into a session identifier. Branch selection alone
 *  would not need it; that path does. */
function randomIndex(n: number): number {
  const limit = Math.floor(0x100000000 / n) * n;
  for (;;) {
    const v = randomBytes(4).readUInt32BE(0);
    if (v < limit) return v % n;
  }
}

/** Test seam — exposes the underlying dictionary so test assertions
 *  can verify the allocator only picks from approved names. Production
 *  callers should never need this. */
export function colourDictionary(): readonly string[] {
  return COLOURS;
}

/** Validate a branch name (allocated, user-proposed, or agent-proposed).
 *  Stricter than git's own ref rules: letters, digits and hyphens only,
 *  must start with a letter, length 3-49. That rules out the entire class
 *  of "looks like a flag" / "looks like a path" ambiguities.
 *
 *  Letters are case-INSENSITIVE for acceptance but the reserved check folds
 *  case: "Main" and "MAIN" are rejected exactly like "main", because git
 *  would resolve them to the same ref on a case-insensitive filesystem. */
export function isValidBranchName(name: string): boolean {
  if (!BRANCH_RE.test(name)) return false;
  if (RESERVED_BRANCHES.has(name.toLowerCase())) return false;
  return true;
}

// ── Background-rename heuristic ─────────────────────────

/** Stop words dropped from prompt-derived branch names. Pure
 *  syntactic noise — keeping them would make branch names like
 *  "add-the-canvas-zoom" instead of "add-canvas-zoom". Verbs are
 *  preserved because "fix" / "add" / "implement" carry semantic
 *  weight ("fix-auth" vs. just "auth"). */
// prettier-ignore
const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "of", "to", "for", "in", "on", "at", "by", "as", "from", "with",
  "and", "or", "but", "so", "if", "then", "than", "that", "this",
  "these", "those", "it", "its", "i", "we", "you", "they", "them",
  "he", "she", "his", "her", "their", "our", "my", "your", "me", "us",
  "have", "has", "had", "having", "do", "does", "did", "doing", "done",
  "should", "would", "could", "shall", "will", "may", "might", "must",
  "can", "cannot", "please", "kindly", "let", "lets",
]);

const MAX_BRANCH_WORDS = 5;
const MIN_WORD_LENGTH = 2;

/** Derive a branch name from a free-form user prompt. Returns the
 *  derived name (without the "zeros/" prefix) if a valid slug can be
 *  produced; returns null if the prompt is too short / contains nothing
 *  useful / generates a reserved name.
 *
 *  Algorithm:
 *    1. Lowercase, strip non-alphanumerics → words separated by spaces.
 *    2. Drop stop words and 1-character tokens.
 *    3. Take the first `MAX_BRANCH_WORDS` significant words.
 *    4. Hyphen-join, truncate to fit BRANCH_RE max length (49).
 *    5. Validate; if it fails (reserved / too short), return null.
 *
 *  We intentionally don't dedupe words — repetition in a prompt
 *  ("add the add button") signals emphasis and should survive. We do
 *  cap the total token count.
 *
 *  Examples:
 *    "Add canvas zoom support"     → "add-canvas-zoom-support"
 *    "Fix the auth bug in login"   → "fix-auth-bug-login"
 *    "Please refactor button"      → "refactor-button"
 *    "?? ! ?"                      → null
 *    "the the the"                 → null  (all stop words)
 */
export function deriveBranchNameFromPrompt(prompt: string): string | null {
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    return null;
  }
  const lowered = prompt.toLowerCase();
  // Replace anything that isn't a-z, 0-9, or whitespace with a space.
  const normalised = lowered.replace(/[^a-z0-9\s]+/g, " ");
  const tokens = normalised
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => t.length >= MIN_WORD_LENGTH)
    .filter((t) => !STOP_WORDS.has(t));
  if (tokens.length === 0) return null;
  const significant = tokens.slice(0, MAX_BRANCH_WORDS);
  // Hard-truncate so the joined string never exceeds the 49-char ceiling
  // imposed by BRANCH_RE. Re-join, then if still over, drop trailing
  // words until it fits.
  let joined = significant.join("-");
  while (joined.length > 49 && significant.length > 1) {
    significant.pop();
    joined = significant.join("-");
  }
  // If a single overlong word is still too big, hard-truncate it.
  if (joined.length > 49) {
    joined = joined.slice(0, 49);
  }
  // Strip trailing hyphens left over from truncation.
  joined = joined.replace(/-+$/g, "");
  if (joined.length < 3) return null;
  if (!isValidBranchName(joined)) return null;
  return joined;
}
