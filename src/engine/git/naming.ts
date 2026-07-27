// Workspace + branch naming. Two generators here:
//
//   1. workspaceId — short hex + kebab slug (`ws_8f3a2c-add-canvas-zoom`).
//      Short hex gives a stable DB key; the kebab slug makes the folder
//      legible in `pwd`/`ls`. Pure UUIDs are hostile in shells; pure names
//      collide. When no prompt hint is supplied, we fall back to a
//      flower name (`ws_8f3a2c-rose`) — see FLOWERS dictionary below.
//
//   2. branchName — flower + 4-char hex (`zeros/orchid-9a2f`). Each
//      workspace gets a fresh, easy-to-remember flower name. ~250
//      single-word species × 65k hex tails = ~16M unique combinations,
//      which is more than enough for any single-user install.
//      The agent / the renderer may later replace this auto name via
//      `workspace_propose_branch_name` (see rename-hook.ts).

import { randomBytes } from "node:crypto";

/** Curated list of ~250 single-word flower names. All lowercase a-z,
 *  3-12 chars, recognisable to anyone with a passing interest in
 *  flowers. Sorted alphabetically for ease of editing. Don't include
 *  multi-word species ("morning-glory") or those that overlap with
 *  reserved branch names. */
const FLOWERS = [
  "acacia", "achillea", "aconite", "agapanthus", "ageratum", "alchemilla",
  "allium", "almond", "aloe", "alstroemeria", "althea", "alyssum",
  "amaranth", "amaryllis", "anemone", "angelica", "anise", "anthurium",
  "arabis", "arnica", "arum", "aster", "astilbe", "astrantia",
  "aubrieta", "azalea",
  "balsam", "baneberry", "begonia", "bellflower", "bergamot", "betony",
  "bittersweet", "bluebell", "bluebonnet", "bluet", "borage",
  "bottlebrush", "bouvardia", "broom", "bryony", "buddleia", "bugloss",
  "buttercup",
  "caladium", "calendula", "calla", "camas", "camellia", "campanula",
  "candytuft", "canna", "canterbury", "capsicum", "caraway", "cardinal",
  "carnation", "catkin", "catmint", "cattleya", "ceanothus", "celosia",
  "centaurea", "chamomile", "chicory", "chionodoxa", "chive", "cineraria",
  "cinquefoil", "clarkia", "clematis", "cleome", "clivia", "clover",
  "cobaea", "coleus", "columbine", "coneflower", "convolvulus", "coreopsis",
  "coriander", "cornflower", "corydalis", "cosmos", "cowslip", "crocus",
  "crinum", "crocosmia", "cyclamen", "cymbidium",
  "daffodil", "dahlia", "daisy", "daphne", "datura", "delphinium",
  "dendrobium", "dianthus", "diascia", "didiscus", "digitalis", "dogwood",
  "echinacea", "echinops", "echium", "edelweiss", "elderflower", "endymion",
  "erica", "erigeron", "eryngium", "eschscholzia", "eucharis", "euphorbia",
  "evergreen",
  "fennel", "feverfew", "filaree", "flax", "fleabane", "forsythia",
  "frangipani", "freesia", "fritillary", "fuchsia",
  "gaillardia", "galanthus", "gardenia", "gaura", "gazania", "gentian",
  "geranium", "gerbera", "gladiolus", "godetia", "goldenrod", "gomphrena",
  "gorse", "guelder", "gypsophila",
  "harebell", "hawthorn", "heather", "hebe", "helenium", "helianthus",
  "heliotrope", "hellebore", "hesperis", "heuchera", "hibiscus",
  "hollyhock", "honesty", "honeysuckle", "hosta", "hyacinth", "hydrangea",
  "hypericum", "hyssop",
  "iberis", "impatiens", "iris", "ixora",
  "jacaranda", "jasmine", "jonquil", "juniper",
  "kalmia", "kerria", "knapweed", "kniphofia", "kolkwitzia",
  "laburnum", "lamium", "lantana", "larkspur", "lavatera", "lavender",
  "leucanthemum", "lewisia", "liatris", "lilac", "lily", "linaria",
  "lobelia", "lotus", "lunaria", "lungwort", "lupine",
  "magnolia", "mahonia", "mallow", "malva", "marguerite", "marigold",
  "mayflower", "mertensia", "mignonette", "milkweed", "mimosa", "monarda",
  "monkshood", "montbretia", "moonflower", "moss", "mullein", "myosotis",
  "myrtle",
  "nandina", "narcissus", "nasturtium", "nemesia", "nemophila", "nepeta",
  "nettle", "nicotiana", "nigella",
  "oleander", "orchid", "oregano", "osmanthus", "osteospermum", "oxalis",
  "pansy", "papaver", "parsley", "peony", "periwinkle",
  "petunia", "phacelia", "phalaenopsis", "philadelphus", "phlox", "pieris",
  "pimpernel", "pinks", "platycodon", "plumbago", "plumeria", "polemonium",
  "polyanthus", "poppy", "portulaca", "primrose", "primula", "privet",
  "protea", "pulmonaria", "pulsatilla",
  "quaking", "quince",
  "ranunculus", "raphiolepis", "redbud", "rhododendron", "rose", "rosemary",
  "rudbeckia",
  "saffron", "sage", "salvia", "saxifrage", "scabiosa", "scilla",
  "sedum", "senecio", "shasta", "silene", "skimmia", "skullcap",
  "snapdragon", "snowdrop", "solanum", "solidago", "sorrel", "speedwell",
  "spiderwort", "spirea", "stachys", "statice", "stephanotis", "stock",
  "stocks", "sunflower", "sweetpea", "syringa",
  "tansy", "thistle", "thyme", "tigerlily", "tigridia", "tithonia",
  "tradescantia", "trillium", "tritoma", "tulip", "turtlehead",
  "verbena", "veronica", "vetch", "viburnum", "vinca", "viola", "violet",
  "wallflower", "weigela", "wisteria", "woodbine", "woodruff",
  "xeranthemum",
  "yarrow", "ylang", "yucca",
  "zauschneria", "zenobia", "zinnia",
];

const SLUG_CLEAN_RE = /[^a-z0-9]+/g;
const SLUG_EDGE_RE = /^-+|-+$/g;
const BRANCH_RE = /^[a-z][a-z0-9-]{2,48}$/;
/** Branch refs reserved by tooling — never accept these as user-proposed
 *  names. Lower-case only since validate() normalizes input. */
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
  // Fall back to a flower name so the folder name never looks like
  // "ws_8f3a2c-" with a trailing dash from an empty slug. Picks the
  // same flower the branch generator uses (same dictionary).
  return pickFlower();
}

function pickFlower(): string {
  return FLOWERS[Math.floor(Math.random() * FLOWERS.length)];
}

/** Generate an auto-branch name like "zeros/orchid-9a2f". 4-char hex
 *  gives 65,536 unique tails per flower (~250 flowers in the
 *  dictionary), so the total search space is ~16M — large enough that
 *  collisions on a single dev machine are effectively impossible.
 *
 *  Pattern adopted 2026-05-20 (roadmap 03a follow-up D): replaces the
 *  prior `zeros/<adj>-<noun>-<hex>` scheme. Flowers are more
 *  pronounceable and easier to remember at a glance than an adjective-noun
 *  pair, while staying a single word so they survive shell completion. */
export function generateBranchName(): string {
  const flower = pickFlower();
  const hex = randomBytes(2).toString("hex"); // 4 chars
  return `zeros/${flower}-${hex}`;
}

/** Test seam — exposes the underlying dictionary so test assertions
 *  can verify the generator only picks from approved names. Production
 *  callers should never need this. */
export function flowerDictionary(): readonly string[] {
  return FLOWERS;
}

/** Validate a user-proposed (or agent-proposed) semantic branch name. We
 *  intentionally keep this stricter than git's own ref rules — only
 *  lowercase a-z, digits, and hyphens, must start with a letter, length
 *  3-49. This avoids the entire class of "looks like a flag" or
 *  "looks like a path" branch ambiguities, and matches the regex in
 *  roadmap 03a. */
export function isValidBranchName(name: string): boolean {
  if (!BRANCH_RE.test(name)) return false;
  if (RESERVED_BRANCHES.has(name)) return false;
  return true;
}

// ── Background-rename heuristic ─────────────────────────

/** Stop words dropped from prompt-derived branch names. Pure
 *  syntactic noise — keeping them would make branch names like
 *  "add-the-canvas-zoom" instead of "add-canvas-zoom". Verbs are
 *  preserved because "fix" / "add" / "implement" carry semantic
 *  weight ("fix-auth" vs. just "auth"). */
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
