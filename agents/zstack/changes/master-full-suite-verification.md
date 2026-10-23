# Master runs the full suite; subagent selections miss coupled failures

- **Symptom.** A subagent reported its batch green on a hand-picked set of
  adjacent suites. The master's full `pnpm test:git` then failed three suites
  the selection did not include: a lifecycle test that located its effect by a
  call the batch removed from that effect's source text, `control-plane-scope`
  rejecting a control-plane test importing a fixture outside its CI scope, and
  `zstack.test.ts` rejecting a pending eval reference.
- **Cause.** Coupling by source text, CI path scope and pack validation is
  invisible from the edited files.
- **Rule.** In master plus subagent mode, require whole touched test
  directories from the subagent and run the full suite before each commit
  (`skills/zstack/SKILL.md`). Separately, on Amazon Linux, the control-plane
  database suites need `postgresql18-contrib` for `citext` and `pgcrypto`
  (`skills/zstack-verify/SKILL.md`).
- **Encoded in.** The two skill rules above. The coupled suites themselves
  already fail on regression; the missing step was running them.
