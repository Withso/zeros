# macOS UI smoke is not the Linux gate

Target: `skills/zstack-verify` (UI smoke on macOS).

- **Symptom.** `pnpm test:ui-smoke` on macOS stopped in `text-selection`.
  Run by shard, it also failed in `code-review`, `overlay-positioning`,
  `scroll-area-drag` and a Create drafts step, none of which the change
  touched. CI's three Linux shards passed the same head.
- **Cause.** Those checks pass on Linux and fail the same way at the merge
  base on macOS (for example, Control+A is not Select All there); the Create
  drafts step also passed when rerun alone. A crash ends its whole run, so the
  scenarios after it never ran. The first base comparison never started: Vite
  ignores a tree under `.context/`, and a symlinked `node_modules` is outside
  its development serving boundary.
- **Rule.** On macOS, run each `--shard=k/3` separately. To reach scenarios
  after a crash, stub the crashing one through `runSmokeScenarios`'
  `loadModule` in a temporary runner. Compare each failing check with the
  merge base in a worktree outside `.context/` that installs its own
  dependencies (`pnpm install --frozen-lockfile`), so a dependency change on
  the branch cannot fail the base too. Report a failure the base reproduces
  as existing; CI's Linux shards gate that scenario. A failure the base does
  not reproduce is new and blocks handoff until it is fixed or explained.
- **Encoded in.** Guidance only. Pressing `ControlOrMeta+A` in
  `ui-smoke-scroll-area-drag.mjs` would make that check platform-neutral.
