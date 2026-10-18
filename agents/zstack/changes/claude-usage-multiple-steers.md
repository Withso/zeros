# A second steer dropped the preceding usage state

The inline Claude usage change passed a one-steer fixture, but a second steer
made a hidden warning reappear or showed recovery while another budget was
still constrained. Grouping attached preceding provider events only to the
final segment; the previous tail lost that history when another steer arrived.

Rule: when status is projected within visual segments, preserve the provider
history through every segment. Test a segment moving out of the tail, independent
budget recovery, and reference stability while later output streams.

Encoded in `turn-event-list-streaming.test.ts`, `turn-grouping.test.ts`,
`stable-turns.test.ts`, and `docs/agent-tool-presentation.md`. Six regression cases
failed before the grouping fix. This was caught in branch review before merge;
the `claude-usage-status-inline` eval runs the rendering regressions.
