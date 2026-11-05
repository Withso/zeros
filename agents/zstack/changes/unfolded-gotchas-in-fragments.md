# Unfolded environment facts live in fragments, not yet in gotchas.md

Target: `skills/zstack-verify` ("When a check fails").

**Symptom.** In a cloud container a composer change hit three known
environment failures in a row: every Chromium-backed Vitest suite failed with
`Executable doesn't exist at …/chromium_headless_shell-1217/…`, `pnpm typecheck`
reported about 250 errors in `apps/control-plane`, and dozens of engine Git
suites failed on commits. Each was rediscovered from scratch.

**Cause.** `zstack-verify` sends a failing check to `gotchas.md`, but all three
facts were still in waiting fragments
(`cloud-container-browser-and-harness-gotchas.md`,
`cloud-session-and-merge-gotchas.md`) that the pack owner had not folded yet.

**Rule.** When a check fails for a reason the diff does not explain, search
`agents/zstack/changes/*.md` as well as `gotchas.md` before investigating, for
example `grep -ril '<error text>' agents/zstack/gotchas.md agents/zstack/changes`.

**Encoded in.** This fragment until it is folded into the skill's "When a
check fails" line.
