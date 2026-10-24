# Register every advisory lock's purpose

- **Symptom.** A new retention advisory lock passed every adjacent suite and
  failed only `src/database-lock-tags.test.ts` in the full control-plane run.
- **Cause.** Every `pg_*advisory*` statement needs exactly one
  `/* lock_purpose='…' */` comment naming a purpose registered in
  `ADVISORY_LOCK_PURPOSES` (`database-timing.ts`); the check scans all sources.
- **Rule.** Tag and register a lock in the change that adds it, and run
  `src/database-lock-tags.test.ts` whenever SQL gains an advisory lock.
