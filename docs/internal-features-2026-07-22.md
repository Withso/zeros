# Internal features — the Settings → Internal tab

_2026-07-22. Owns the policy + wiring for team-only features. The code of
record: `src/zeros/settings/internal-features.ts` (allowlist + flags),
`src/zeros/panels/settings-page.tsx` (the tab + gate),
`src/shell/use-copy-logs-hotkey.ts` (the first feature)._

## What "Internal" is (and is not)

Three tiers of feature gating now exist, and they must not be conflated:

| Tier                                       | Who sees it                         | Who can enable it                      | Example         |
| ------------------------------------------ | ----------------------------------- | -------------------------------------- | --------------- |
| **Experimental** (Settings → Experimental) | every user                          | every user, per install                | Terminal Agents |
| **Internal** (Settings → Internal)         | allowlisted team accounts only      | allowlisted accounts only, per install | Copy logs (⇧⌘L) |
| **PostHog feature flags**                  | n/a (remote analytics-side rollout) | server-side                            | none yet        |

Internal features are **not** feature flags in the rollout sense — many will
never ship to users at all. They are team-only debugging/dogfooding surfaces.
PostHog flags are deliberately NOT involved: an internal feature must work
offline, must never depend on a third-party evaluation, and must never be
enumerable by a non-internal client.

## Who is internal

`INTERNAL_USER_EMAILS` in `src/zeros/settings/internal-features.ts` — currently
`arunrajkumar@withso.com`. Adding a teammate = adding one email to that array.

The gate compares against `useAuth().email`, which is trustworthy for this
purpose: it is set by the **server's** handoff-redeem response after the Auth0
browser sign-in (`electron/ipc/commands/auth-handoff.ts`), persisted by the
main process in the OS keychain, and mirrored read-only to the renderer
(`auth_get_session_user`). The user cannot edit it. Signed out ⇒ `email` is
`null` ⇒ nothing internal exists.

One trust caveat lives outside this repo: the chain is only as strong as the
IdP's email verification. If the Auth0 tenant ever allows database signups
with unverified emails, someone could register an allowlisted address without
owning the inbox. Before any internal feature gains real power (beyond
copying one's own local logs), confirm the tenant enforces `email_verified`
(or restricts connections to Google/GitHub) at the handoff-redeem server —
and add a main-process email assertion for that feature (see the double-gate
section).

## Per-app (per-channel) scoping — the whole point

Flags persist to `localStorage` (`zeros.internalFeatures`). Each channel runs
as its own app with its own userData directory
(`src/engine/db/paths.ts` → `com.zeros` / `com.zeros.beta` / `com.zeros.dev`,
plus per-worktree dev slugs), so each has its own localStorage:

- enable Copy logs in **Zeros Beta** → Production and Dev are untouched;
- enable it in **Production** → Beta and Dev are untouched.

No extra keying is needed — never add channel names into the storage key.

## The double gate (leak prevention)

Every internal feature has exactly two gates, and **both** are enforced at
every runtime surface:

1. **allowlist** — `isInternalUserEmail(session email)`;
2. **flag** — the per-install switch in the Internal tab.

The only sanctioned consumer APIs are `useInternalFeatureActive(feature)`
(React) and `isInternalFeatureActive(feature, email)` (non-React). Never gate
runtime behavior on the raw flag (`useInternalFeature` /
`isInternalFeatureEnabled` are for the Internal panel's switches only):
localStorage is user-editable, so a forged `{"copyLogs":true}` must still do
nothing for a non-internal account.

Discoverability rules — an internal feature must leave **no usable trace**
for non-internal users. (The guarantee is capability + UI invisibility, not
binary secrecy: the allowlist emails and feature code ship in the renderer
bundle, so someone unpacking the asar can learn they exist — they still can't
activate them.)

- **No sidebar entry**: the Internal tab is dropped from `availableSections`
  in `settings-page.tsx` unless `useIsInternalUser()` holds. That same filter
  makes a stale/forged persisted selection (`user:internal`) unresolvable — it
  falls back to the first section — and the retained-panel render map also
  resolves through `availableSections`, so a previously mounted panel cannot
  survive a sign-out.
- **No shortcut listeners**: hotkey hooks attach their keydown listener only
  while `useInternalFeatureActive(...)` holds (see `use-copy-logs-hotkey.ts`).
  When gated off, the chord is inert — no `preventDefault`, no dead key.
- **No catalog entries**: internal shortcuts are deliberately absent from the
  ⌘/ shortcuts catalog (`src/shell/shortcuts-catalog.ts`), the Help menu, and
  every other discoverable surface. Do not add them.
- **No new privileged IPC without a main-side check**: renderer-only gating is
  acceptable only when the underlying IPC command is something any user could
  already trigger through existing UI (Copy logs reuses `logs_recent`, the
  feedback pipeline). A future internal feature that needs a command with
  powers beyond that must also verify the session email **in the main
  process** (main owns the keychain session — `readTokens().email`), because
  a devtools-capable user can invoke any registered IPC command directly.

## Feature #1 — Copy logs (⇧⌘L)

- Toggle: Settings → Internal → "Copy logs". Off by default.
- Chord: **⇧⌘L**, matched on `e.code === "KeyL"`; skips key auto-repeat and
  keystrokes already claimed by a more specific surface
  (`event.defaultPrevented`); fires inside editable surfaces too (it types
  nothing). ⌘L without Shift stays with the browser-tab element picker
  (which now rejects Shift/Option so the chords can't double-fire); ⌥⌘L
  stays free. Known dead zones, shared with every global chord: a focused
  xterm terminal (xterm claims mod-chords; the Ctrl variant would reach the
  PTY as a control char) and the embedded browser-tab iframe (keys don't
  bubble to the host window) — press it with any other surface focused.
- Action: `logs_recent` IPC → the scrubbed recent-log tail — byte-identical to
  what a feedback submission attaches (secret-scrubbed in main via
  `redactLogSecrets`, capped at `MAX_EXPORT_CHARS = 500_000` chars ≈ 500 KB,
  trimmed to whole JSONL lines) → `navigator.clipboard.writeText`.
- Feedback: a toast on every outcome (copied — N KB / no logs yet / failed),
  so a press is never ambiguous.

## Adding internal feature #N — checklist

1. Extend the `InternalFeature` union in `internal-features.ts` and document
   the flag in its doc comment.
2. Add a `SettingsRow` + `Switch` to `InternalPanel` in `settings-page.tsx`
   using `useInternalFeature("yourFlag")`.
3. Gate every runtime surface on `useInternalFeatureActive("yourFlag")` —
   attach listeners/mount surfaces only while it holds.
4. Audit for leaks: no catalog/menu/tooltip entries, no visible dead controls,
   no renderer-trusted privileged IPC (see the double-gate section).
5. Tests: extend `src/zeros/settings/__tests__/internal-features.test.ts`
   (gate math) and add a matcher/behavior test if there's a hotkey.
