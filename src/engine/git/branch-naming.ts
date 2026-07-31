// ──────────────────────────────────────────────────────────
// Branch-name RULES — the half of naming.ts both processes need
// ──────────────────────────────────────────────────────────
//
// The engine NAMES a workspace branch; the renderer LABELS it and previews
// what a settings change will produce. Both therefore need the same answers to
// "where does the prefix end" and "what is a usable prefix" — and when the two
// disagree the failure is silent and user-visible: Settings → Git promises
// `hello/Cream` while the engine writes `zeros/Cream`, or a tab shows a whole
// ref where every other surface shows the short name.
//
// So the rules live HERE, in a module with no imports at all, and both sides
// import this one definition. `naming.ts` re-exports it so engine call sites
// are unchanged; `zeros/lib/branch-name.ts` re-exports it for the renderer.
//
// Split out on 2026-07-29. Until then the renderer kept a hand-copied mirror,
// because naming.ts pulls `node:crypto` for the colour allocator and that
// cannot go in the browser bundle. Only the ALLOCATOR needs crypto — every
// rule below is pure string work — so the split costs nothing and removes the
// "change both together" comment that was the only thing holding the two
// copies in agreement. Precedent: settings/env-names.ts, a node-free engine
// module the renderer imports directly (zeros/agent/env-vault.ts).
//
// KEEP THIS FILE IMPORT-FREE. A single `node:`/npm import here re-creates the
// problem it exists to solve.
// ──────────────────────────────────────────────────────────

/** The default prefix SEGMENT (no separator — see joinBranchPrefix). Still what
 *  marks a ref as workspace-owned for every workspace created before Settings →
 *  Git offered a choice. */
export const DEFAULT_BRANCH_PREFIX = "zeros";

/** The default prefix as it appears at the head of a branch. Its own constant
 *  because branchDisplayName matches it as a LITERAL: everything under `zeros/`
 *  is ours by construction, whatever the tail looks like. */
export const BRANCH_PREFIX = `${DEFAULT_BRANCH_PREFIX}/`;

/** The one character that joins a prefix to a workspace name. Git namespaces
 *  are slash-delimited, so this is not a style choice — `jordan/Cream` groups
 *  under `jordan` in `git branch`, on the remote, and in every GitHub branch
 *  picker, while `jordan-Cream` is just a flat name that happens to start with
 *  the same letters. */
const BRANCH_PREFIX_SEPARATOR = "/";

/** Longest prefix a user may configure, measured AFTER normalization. Bounded
 *  because the prefix is joined onto a name that must still satisfy git's own
 *  ref rules and stay legible in a tab — and because an unbounded string here
 *  reaches a `git update-ref` argument. */
const MAX_BRANCH_PREFIX_LENGTH = 64;

/** A configurable prefix is stricter than git's ref grammar on purpose. It may
 *  contain inner slashes (`team/feature`) but must not start with one, end with
 *  a dot, contain `..`, or carry anything that could read as a flag or a path
 *  escape. Anchored, so a partial match can't sneak through. */
const BRANCH_PREFIX_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** Normalize a user-supplied branch prefix to a bare NAMESPACE — no leading or
 *  trailing separator — or return null when it can't be used (empty, over-long,
 *  or shaped like something git would reject or a shell would misread). A null
 *  result means "fall back to the default"; a bad prefix must never block
 *  workspace creation.
 *
 *  The prefix is a NAME, not a fragment (2026-07-29 founder direction): the
 *  caller joins it with exactly one `/` (joinBranchPrefix), so `jordan` and
 *  `jordan/` mean the same namespace and both produce `jordan/Cream`. Before
 *  this, the value was spliced in verbatim and the pane had to ask users to
 *  "include the separator" — which made `hello` silently produce the flat
 *  `helloCream` instead of the `hello/Cream` everyone read it as.
 *
 *  Only `/` is normalized away. A trailing `-` or `_` is left alone and joined
 *  as-is (`myname-` → `myname-/Cream`), because those characters are ordinary
 *  name characters here and silently trimming them would edit what the user
 *  typed. The settings preview shows the exact resulting branch, so the shape
 *  is visible before any branch is created. */
export function normalizeBranchPrefix(raw: string | undefined): string | null {
  // Strip surrounding whitespace, then any leading/trailing separators. The
  // separator strip is what makes `feature/` — the shape the old pane told
  // people to type — keep producing `feature/Cream` rather than `feature//Cream`.
  const trimmed = (raw ?? "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (!trimmed) return null;
  if (trimmed.length > MAX_BRANCH_PREFIX_LENGTH) return null;
  if (!BRANCH_PREFIX_RE.test(trimmed)) return null;
  // Git ref rules the character class alone can't express.
  if (trimmed.includes("..")) return null;
  // An INNER `//` survives the strip above and is genuinely ambiguous — we
  // can't tell an empty namespace from a typo, so refuse rather than guess.
  if (trimmed.includes("//")) return null;
  // PER COMPONENT, not just on the whole string: git applies "no leading dot"
  // and "no .lock suffix" to every slash-separated part. Checking only the
  // ends let `foo.lock/` and `a/.b/` through — accepted here, then rejected by
  // `git check-ref-format` at create time, which turned a bad setting into an
  // opaque GIT_COMMAND_FAILED on every workspace create. This function's whole
  // contract is that a bad prefix falls back instead of breaking creation.
  for (const part of trimmed.split(BRANCH_PREFIX_SEPARATOR)) {
    if (part.startsWith(".")) return null;
    if (part.endsWith(".") || part.endsWith(".lock")) return null;
  }
  return trimmed;
}

/** Build a branch from a normalized prefix and an allocated name, with exactly
 *  one separator between them. A null/empty prefix yields the bare name — the
 *  `none` setting, which must not leave a dangling `/`. */
export function joinBranchPrefix(
  prefix: string | null | undefined,
  name: string,
): string {
  return prefix ? `${prefix}${BRANCH_PREFIX_SEPARATOR}${name}` : name;
}

/** The allocator's name shape — a capitalized colour, optionally `-vN`. Its
 *  distinctiveness is what lets branchDisplayName strip a prefix it has never
 *  seen: only a name in this shape could have come from pickFreeColourName. */
const ALLOCATED_NAME_RE = /^[A-Z][a-z]{2,15}(?:-v[1-9][0-9]{0,2})?$/;

/** The allocator name at the END of a string, if any: `myname-Cream` → `Cream`,
 *  `Cream` → `Cream`, `login-fix` → null.
 *
 *  Unlike branchDisplayName this does not care about slashes — it answers "does
 *  this string end in a name we could have handed out", which is what the
 *  used-name scan needs in order to reserve a colour that is buried inside
 *  somebody else's ref path. */
export function allocatedNameSuffix(value: string): string | null {
  const match = /[A-Z][a-z]{2,15}(?:-v[1-9][0-9]{0,2})?$/.exec(value);
  return match ? match[0] : null;
}

/** Strip the ownership prefix to get the display name: `zeros/Cream` →
 *  `Cream`, `jordan/Cream` → `Cream`.
 *
 *  Two strip cases, and no others:
 *
 *    1. the legacy `zeros/` prefix — everything under it is ours by
 *       construction, whatever the name looks like, which keeps
 *       pre-2026-07-29 workspaces (`zeros/lupine-1a2b`, the old lowercase
 *       flower scheme) reading correctly;
 *    2. any prefix whose tail is an allocated colour name — that is how a
 *       branch created under a CONFIGURED prefix (Settings → Git) is
 *       recognized without knowing which prefix was in force when it was made.
 *       An allocated name can never contain a slash, so the last slash is
 *       always the boundary.
 *
 *  Everything else passes through whole: a branch Zeros did not name — an
 *  adopted `cursor/foo`, a user's own `feature/plain` — keeps its namespace,
 *  because there the prefix is identity, not bookkeeping.
 *
 *  This is a LABELLING rule, not a general prefix parser. renameBranch wants a
 *  different boundary (the last slash, whatever the tail looks like) because a
 *  rename replaces the name half of any ref, allocator-shaped or not — see
 *  resolveExistingBranchPrefix in branch.ts.
 *
 *  KNOWN IMPRECISION: rule 2 tests the name SHAPE, not membership in COLOURS,
 *  so a foreign branch whose tail happens to be TitleCase is stripped too —
 *  adopted `feature/Login` and `hotfix/Login` both label as `Login`. Now that
 *  this module is shared, tightening it to the real dictionary is possible
 *  (COLOURS could move here too); it is left as-is because the imprecision only
 *  affects the LABEL of a branch Zeros did not create. The disk side is
 *  unaffected: managedWorkspacePath's collision loop already suffixes a taken
 *  directory. */
export function branchDisplayName(branch: string): string {
  if (branch.startsWith(BRANCH_PREFIX))
    return branch.slice(BRANCH_PREFIX.length);
  const cut = branch.lastIndexOf(BRANCH_PREFIX_SEPARATOR);
  if (cut === -1) return branch;
  const tail = branch.slice(cut + 1);
  return ALLOCATED_NAME_RE.test(tail) ? tail : branch;
}
