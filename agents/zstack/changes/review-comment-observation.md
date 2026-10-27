# Comment availability and shared foreground observation

- Symptom: Changes showed a lingering Loading comments row, cloud review reads
  opened unsupported connections, and every Local GitHub consumer ran its own
  interval even while the window was hidden.
- Cause: placement was checked inconsistently, loading alone owned a padded
  feedback wrapper, and request deduplication concealed duplicate timer work.
- Rule: one availability predicate gates the hook, bridge and comment controls.
  Pending status may feed workbench chrome without inline placeholder text.
  Keep Local workspace review event-driven and preserve its pagination/writes.
- GitHub review needs one active observer per exact workspace/PR, next-due
  scheduling after settlement, bounded unchanged/error backoff, and immediate
  focus/reconnect/revision/explicit refresh. Count timer callbacks while hidden,
  not just requests. Last release and deletion cancel scheduling and fence held
  replies; a reopened key must own a new read while retaining confirmed rows.
- Encoded in `review-feedback.test.ts`, `review-availability.test.ts`,
  `github-review-observation.test.ts` and `code-review-bridge.test.ts`. The real
  code-review browser scenario covers pending Changes, cloud Files/editor/diff
  comment controls, and continued Git hunk actions alongside Local mutations.
- A renderer-only cwd must be stripped before strict protocol parsing, after
  availability is checked. Exercise the real Local bridge as well as mocked
  hooks: only the real boundary caught the accidental extra wire field.
- Theme captures must switch the appearance store so syntax and DOM themes
  change together; editing only `data-theme` can produce a false light capture.
