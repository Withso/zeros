# Background-task display clocks must release hidden timers

Symptom: a retained active chat's elapsed label still scheduled 60 callbacks
per minute while its window was hidden. Two waiting chat views owned two
independent intervals. Reveal could show an old label until another tick.

Cause: the consumer checked its surface's `active` prop, which does not change
when the whole document is hidden. An interval that merely skips rendering
would still wake the renderer; a display clock needs timer ownership tied to
visibility and to its final consumer.

Rule: share the visible display clock, stop it while hidden or unused, and
sample wall time immediately on reveal. Snapshot reads cannot advance the
published clock and consume another consumer's notification. These clocks
must never replace authoritative task, authentication, or request deadlines.

Encoded in the bug-fix playbook, the real background-task consumer regression,
and the transcript browser reveal check. Unit tests count scheduled callbacks
and cover late visibility, A to B to A start times, and final-unsubscribe
cleanup. The browser advances wall time within one task so a later timer
cannot make reveal falsely pass. These are source/browser budgets, not a
macOS energy measurement or a claim that other display clocks are converted.
