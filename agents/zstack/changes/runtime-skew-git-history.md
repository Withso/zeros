# Runtime skew gate needs full history and Git 2.44

- Symptom: `pnpm check:runtime-skew` failed with
  `runtime_skew_source_unavailable` in a fresh cloud checkout, and again
  after the pinned commit had been fetched.
- Cause: the checkout was shallow, and the gate runs `git --no-lazy-fetch`,
  which Git 2.43 (Ubuntu 24.04) rejects. The gate's closed diagnostic maps
  both to the same code. A missing `apps/control-plane` install fails it
  earlier with a module error.
- Rule: fetch full history and check `git --version` before suspecting the
  pins. A later structural fix should give an unsupported Git its own code.
- Encoded in `skills/zstack-verify/SKILL.md` (Gotchas already paid for).
