// Settings → Git (user scope) — how new workspace branches are named.
//
// The per-REPO git pane (repositories-panel.tsx > GitSection) owns remote +
// base branch. This one owns the branch-name prefix, which is a personal
// preference rather than a property of the repo: two people working in the
// same repo should be able to disagree about whether their branches read
// `zeros/Cream` or `alice/Cream`. So it writes the USER layer, and every repo
// inherits it unless a repo/managed layer overrides.
//
// The value lands in `git.branch_prefix_type` (+ `git.branch_prefix` for the
// custom string). The engine reads it at allocation time only — see
// resolveNewBranchPrefix in engine/git/worktree.ts. Changing it never rewrites
// an existing branch: workspaces keep the prefix they were born with, which is
// why branchDisplayName strips to the last slash rather than matching one
// known prefix.
//
// An UNSET key means "GitHub username" (the engine's
// DEFAULT_BRANCH_PREFIX_TYPE), which is what lets the first row be selected
// from the first launch: there is no state in which this pane shows nothing
// chosen, because "the user hasn't decided" and "the app has no answer" were
// never the same thing.
//
// A prefix is a NAMESPACE, not a fragment: whatever is stored here is joined to
// the workspace name with exactly one `/`, so `jordan` and `jordan/` both give
// `jordan/Cream`. The rules are shared with the engine — normalizeBranchPrefix
// and joinBranchPrefix come from engine/git/branch-naming.ts, so this pane
// cannot promise a branch the engine won't create.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  SettingsSection,
  SettingsList,
  SettingsField,
  SETTINGS_CARD_LIST_CLS,
} from "./settings-ui";
import {
  useResolvedSettings,
  useSettingsLayer,
  useSyncedDraft,
} from "./use-settings";
import { cn } from "../../shared/ui/cn";
import { badgeVariants } from "../../shared/ui/primitives/badge";
import { toast } from "../../shared/ui/primitives/elements";
import { Input } from "../../shared/ui/primitives/input";
import {
  RadioGroup,
  RadioGroupItem,
} from "../../shared/ui/primitives/radio-group";
import {
  DEFAULT_BRANCH_PREFIX,
  joinBranchPrefix,
  normalizeBranchPrefix,
} from "../../shared/lib/branch-name";
import { useGithubLogin } from "./use-github-login";

/** Mirror of BRANCH_PREFIX_TYPES in engine/settings/schema.ts. Duplicated
 *  rather than imported because the renderer must not pull the engine's zod
 *  schema module into the browser bundle; schema.test.ts pins the engine side
 *  and this list is asserted against it in git-defaults.test.ts. */
export type BranchPrefixType = "zeros" | "github" | "custom" | "none";

/** The radio options, in display order. "zeros" is deliberately NOT offered as
 *  a row: surfacing an option literally named after the app reads as branding,
 *  not as a choice, and anyone who wants that namespace can type it into
 *  Custom.
 *
 *  The first row is also the DEFAULT (DEFAULT_BRANCH_PREFIX_TYPE), which is
 *  what makes this list complete: a radio group must never render with nothing
 *  selected, and while the default was the unlisted "zeros" that is exactly
 *  what a fresh install showed — three empty circles and a preview line
 *  describing a fourth option that wasn't there. readType now folds every
 *  value this list can't render onto "github", so `selected` is always one of
 *  these rows. */
export const OPTIONS: Array<Exclude<BranchPrefixType, "zeros">> = [
  "github",
  "custom",
  "none",
];

/** How long the radio may show a pick the effective settings haven't confirmed.
 *  Only reached when confirmation never comes (a higher layer pins the key);
 *  the normal path clears on agreement, well inside this. */
const OPTIMISTIC_HOLD_MS = 3_000;

export function GitDefaultsSection() {
  const resolved = useResolvedSettings();
  const { write } = useSettingsLayer("user");
  const login = useGithubLogin();

  const effective = resolved.resolved?.effective as
    | { git?: { branch_prefix_type?: unknown; branch_prefix?: unknown } }
    | undefined;
  const savedType = readType(effective?.git?.branch_prefix_type);
  const previewType = readPreviewType(effective?.git?.branch_prefix_type);
  const savedPrefix =
    typeof effective?.git?.branch_prefix === "string"
      ? effective.git.branch_prefix
      : "";

  // OPTIMISTIC selection. `savedType` comes from the resolved tree, which is a
  // different document from the one `write` returns — it only updates when the
  // engine's settings broadcast comes back and the renderer re-resolves.
  // Rendering `checked` straight off it meant a click produced no feedback at
  // all until that landed, which (before the engine echo fix — see
  // dbChangedIncludesOriginator) was up to three seconds and read as a dead
  // pane. It is now one round trip, but a cloud bridge still makes that
  // visible, so the dot moves on click.
  const [pending, setPending] = useState<BranchPrefixType | null>(null);
  const selected = pending ?? savedType;

  // Yield on AGREEMENT — when the effective tree says what we optimistically
  // showed. Deliberately not "when any newer tree arrives": settings broadcasts
  // are global, so clicking two options in quick succession would let the FIRST
  // click's echo clear the SECOND click's optimism and the dot would visibly
  // jump backwards. Matching on the value instead is inherently per-click.
  useEffect(() => {
    if (pending !== null && savedType === pending) setPending(null);
  }, [pending, savedType]);

  // …and a bounded safety valve, because agreement is not guaranteed: a managed
  // or repo layer can outrank the user layer we just wrote, and then the
  // effective value never becomes our pick. Without this the radio would sit
  // forever on a choice the engine will never honour. Long enough to cover the
  // engine's own 3s settings-watcher backstop, and re-armed on each new pick.
  useEffect(() => {
    if (pending === null) return;
    const timer = setTimeout(() => setPending(null), OPTIMISTIC_HOLD_MS);
    return () => clearTimeout(timer);
  }, [pending]);

  // The custom draft lives HERE, not in the field, so the preview line below
  // can validate what the user is TYPING. With it inside the child, the preview
  // read the saved value only: typing `my name` showed no objection at all
  // until after it had been written to settings.toml, and previewFor's whole
  // job is to say so before that happens.
  const [draft, setDraft] = useSyncedDraft(savedPrefix);

  // Autofocus the custom field only when the user just PICKED Custom. Keyed on
  // a click rather than on the input mounting: the resolved tree lands a frame
  // or two after the pane opens, so a saved `custom` mounts the field
  // asynchronously, and a mount-keyed focus would yank the caret out of
  // whatever the user was doing on arrival.
  const [focusCustom, setFocusCustom] = useState(false);

  // Only the newest click may report a failure. An earlier write rejecting
  // after the user has already moved on must not drag the dot back.
  const clickSeq = useRef(0);

  const select = (next: BranchPrefixType) => {
    if (next === selected) return;
    const mine = (clickSeq.current += 1);
    setPending(next);
    setFocusCustom(next === "custom");
    void write({ git: { branch_prefix_type: next } }).catch(() => {
      if (clickSeq.current !== mine) return;
      toast.error("Couldn't save the branch name prefix");
      setPending(null);
    });
  };

  return (
    <SettingsSection
      title="Branch name prefix"
      description="Prefix for new workspace branch names."
    >
      <SettingsList className={SETTINGS_CARD_LIST_CLS}>
        {/* No SettingsField label: the section heading above already names
            this control, and a second "Branch name prefix" line would read as
            a nested group. aria-label carries the name for screen readers. */}
        <SettingsField>
          <RadioGroup
            aria-label="Branch name prefix"
            value={selected}
            onValueChange={(v) => select(v as BranchPrefixType)}
          >
            {OPTIONS.map((value) => (
              <RadioGroupItem
                key={value}
                value={value}
                label={labelFor(value, login)}
              >
                {/* Keyed on the OPTIMISTIC selection so the field appears with
                    the dot rather than a round trip later. */}
                {value === "custom" && selected === "custom" && (
                  <CustomPrefixInput
                    saved={savedPrefix}
                    draft={draft}
                    setDraft={setDraft}
                    write={write}
                    autoFocus={focusCustom}
                  />
                )}
              </RadioGroupItem>
            ))}
          </RadioGroup>
        </SettingsField>
      </SettingsList>
      <p className="text-fg2 text-xs">
        {/* An optimistic pick owns the line the moment it's clicked; otherwise
            describe the effective value, including the unrenderable `zeros`. */}
        {previewFor(
          pending ?? previewType,
          selected === "custom" ? draft : savedPrefix,
          login,
        )}
      </p>
    </SettingsSection>
  );
}

/** The `custom` prefix field. Its own component so the draft's lifetime is tied
 *  to the option being active. */
function CustomPrefixInput({
  saved,
  draft,
  setDraft,
  write,
  autoFocus,
}: {
  saved: string;
  /** Owned by the parent (useSyncedDraft) so the preview can see it — it
   *  adopts a value that changed underneath us (another window, a hand-edited
   *  settings.toml) only while the user hasn't diverged, so a write landing
   *  mid-edit can't rewind the field to the half-typed value it just saved. */
  draft: string;
  setDraft: (v: string) => void;
  write: (patch: { git: { branch_prefix: string | null } }) => Promise<void>;
  autoFocus: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);

  // Escape must ABANDON the edit, and it has to say so out of band: it calls
  // blur() to leave the field, blur fires synchronously inside the same React
  // batch, and React then runs the `commit` from the already-committed render —
  // which still closes over the dirty draft. Without this flag, Escape SAVED
  // the value it was pressed to discard.
  const reverting = useRef(false);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  const commit = useCallback(() => {
    const next = draft.trim();
    if (next === saved) return;
    // null DELETES the key rather than storing "": an empty custom prefix means
    // "unset", and the engine then falls back to the default rather than
    // creating unprefixed branches nobody asked for.
    void write({ git: { branch_prefix: next || null } }).catch(() =>
      toast.error("Couldn't save the branch name prefix"),
    );
  }, [draft, saved, write]);

  return (
    <Input
      ref={ref}
      value={draft}
      onChange={(e) => {
        // Any edit ends a pending revert, so a blur that never arrived can't
        // swallow the next commit.
        reverting.current = false;
        setDraft(e.target.value);
      }}
      onBlur={() => {
        if (reverting.current) {
          reverting.current = false;
          return;
        }
        commit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          reverting.current = true;
          setDraft(saved);
          e.currentTarget.blur();
        }
      }}
      spellCheck={false}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      placeholder="eg. name or product"
      aria-label="Custom branch name prefix"
    />
  );
}

/** The row to show for whatever the effective tree holds.
 *
 *  Everything the pane can't render as a row — unset (the common case, and now
 *  `github` by default), the unlisted "zeros", or a garbage value — resolves to
 *  "github". That is the guarantee the radio needs: there is no state in which
 *  nothing is selected.
 *
 *  Honest for every value the app itself can produce, since this pane only ever
 *  writes the three OPTIONS and unset is genuinely `github`. A settings.toml or
 *  team layer that pins "zeros" by hand is the one case where the shown ROW
 *  (GitHub username) can't match what the engine will do (`zeros/`) — the radio
 *  has nowhere else to put it. The preview line is not folded, so it still
 *  reports `zeros/` honestly; that is what the "zeros" arm of previewFor is
 *  for, and why it is kept rather than deleted. */
export function readType(value: unknown): BranchPrefixType {
  return value === "custom" || value === "none" ? value : "github";
}

/** What the PREVIEW line describes — which is not always the selected row.
 *
 *  The fold above exists for the RADIO's sake: it must always have a row to put
 *  the dot on. The preview sentence has no such constraint, and folding it too
 *  is what let the pane contradict the engine: a repo/team layer pinning
 *  `branch_prefix_type = "zeros"` had the line promising `<login>/Cream` while
 *  `zeros/Cream` landed on disk. Every other value resolves identically to
 *  readType, so this only ever differs where the radio genuinely cannot follow. */
export function readPreviewType(value: unknown): BranchPrefixType {
  return value === "zeros" ? "zeros" : readType(value);
}

function labelFor(
  value: Exclude<BranchPrefixType, "zeros">,
  login: string | null,
): ReactNode {
  if (value === "github")
    // Name the account when we know it — "GitHub username" alone leaves the
    // user guessing WHICH account, and they may have several. `login` is the
    // CONNECTED account (useGithubLogin → ghAuthStatus), never a literal, so
    // this row is blank-suffixed rather than wrong when nobody is signed in.
    //
    // A chip rather than the "(login)" parenthetical it replaced: the value is
    // data, not part of the sentence, and the parens were doing a delimiter's
    // job that a filled background does better. `badgeVariants` on a <span>
    // rather than <Badge> because Badge renders a <div> and this sits inside
    // Radix's radio <button> — phrasing content only, so a div there is invalid
    // nesting. Styling remains owned by the primitive.
    //
    // Through `cn`, exactly as <Badge> itself does it, and that is load-bearing
    // rather than habit: cva CONCATENATES, so the base's `text-xs font-semibold`
    // and the neutral variant's `text-sm font-normal` both reach the class
    // attribute. Order within the attribute decides nothing — at equal
    // specificity the later RULE in the stylesheet wins, and Tailwind emits
    // `.text-xs` after `.text-sm`, so the raw call painted this chip at exactly
    // the 13px semibold the variant exists to avoid. tailwind-merge is what
    // resolves the pair.
    return login ? (
      <span className="inline-flex items-center gap-1.5">
        GitHub username
        <span className={cn(badgeVariants({ variant: "neutral" }))}>
          {login}
        </span>
      </span>
    ) : (
      "GitHub username"
    );
  return value === "custom" ? "Custom" : "None";
}

/** A worked example beats a description here: the difference between the four
 *  options is entirely in the resulting string. Built with the same
 *  normalize+join the ENGINE uses (one shared module, not a copy), so `hello`,
 *  `hello/` and `/hello/` all preview `hello/Cream` — which is also what lands
 *  on disk. */
export function previewFor(
  type: BranchPrefixType,
  prefix: string,
  login: string | null,
): string {
  const name = "Cream";
  // Takes a non-null namespace: `none` states the absence in words rather than
  // previewing a bare `Cream`, so there is no caller left that joins nothing.
  const example = (namespace: string) =>
    `New branches will be named like ${joinBranchPrefix(namespace, name)}.`;
  switch (type) {
    case "none":
      // Stated as the ABSENCE, not as `example(null)` — that rendered "named
      // like Cream.", which reads as a naming scheme rather than as the opt-out
      // and gave no hint that the other rows add a namespace in front.
      return "New branches will have no prefix.";
    case "custom": {
      if (!prefix.trim()) return "Enter a prefix.";
      // Say so when the engine will reject it. Without this the pane happily
      // previewed "my name/Cream" while resolveNewBranchPrefix normalized the
      // value to null and created `zeros/Cream` — the one place the UI could
      // contradict what actually lands on disk.
      const namespace = normalizeBranchPrefix(prefix);
      return namespace
        ? example(namespace)
        : `That prefix isn't a valid git ref, so new branches will keep the fallback ${DEFAULT_BRANCH_PREFIX}/ prefix.`;
    }
    case "github":
      // No login is now the FRESH-INSTALL state, because this row is the
      // default — so the ask alone ("Connect GitHub…") left a new user with no
      // idea what their branches would be called in the meantime. Name the
      // fallback first, then the ask: the engine substitutes `zeros/` for an
      // unknown login rather than dropping the namespace.
      return login
        ? example(normalizeBranchPrefix(login) ?? DEFAULT_BRANCH_PREFIX)
        : `New branches will be named like ${joinBranchPrefix(
            DEFAULT_BRANCH_PREFIX,
            name,
          )} until you connect GitHub in Settings → Integrations.`;
    case "zeros":
    default:
      return example(DEFAULT_BRANCH_PREFIX);
  }
}
