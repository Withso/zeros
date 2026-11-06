# Gate a commit on the check's own exit status, never on a pipeline's

Target: `gotchas.md` (Shell and Git).

**Symptom.** While landing the split-pane docs, `pnpm check:ui 2>&1 | tail -3
&& git commit …` committed although `check:ui` had failed on two bare doc
paths. The failure only showed in the trimmed output, and the commit had to
be amended.

**Cause.** A pipeline's exit status is its last command's: `tail` succeeded,
so `&&` ran the commit. Without `set -o pipefail` nothing in Bash carries the
check's own status through the pipe.

**Rule.** Never chain a commit, push or merge after a check piped into `tail`,
`grep` or `head`. Write the check's output to a log, read its status, then act:
`pnpm check:ui > "$log" 2>&1; status=$?; tail -3 "$log"; [ "$status" -eq 0 ]
&& git commit …`. `set -o pipefail` is no substitute: a `head` that stops
reading early can end a passing check with SIGPIPE, and pipefail then reports
it as a failure.

**Encoded in.** This fragment, for `gotchas.md` at the next pack version.
