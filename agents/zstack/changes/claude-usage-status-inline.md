# Deduplication does not choose a transcript position

Above 75% Claude usage, every turn pinned "Claude is nearing its usage limit."
below the newest tool row while later tool calls kept streaming in above it.
Cause: the earlier fix for repeated usage receipts deduplicated by moving one
selected status to the provider turn's tail, so the row's position stopped
following the transcript.

Rule for renderer projections: deduplicate a status by change over its provider
turn, then keep each change in source order like other inbetween feedback.
Moving a row to the tail is a placement decision and needs its own reason.
Replay the real producer through the shared reducer into the partition, so the
emitted order is what reaches the working feed. Copied transcripts use the same
projection.

Encoded in `turn-event-list-streaming`, `turn-partition` (including a
`ClaudeStreamTranslator` → `applyUpdate` ordering test), `transcript-notices`
and `transcript-format` regressions, the `claude-runtime-ui` browser smoke and
`docs/agent-tool-presentation.md`. Eval: `claude-usage-status-inline`.

Verification note: a workspace checkout can hold another agent's uncommitted
work. Verify your own patch in a detached worktree at the base commit (symlink
each `node_modules`) and compare the applied diff with your patch before
trusting a green run. In zsh an unquoted variable holding several paths stays
one argument, which silently produced an empty `git diff -- $PATHS` patch.
