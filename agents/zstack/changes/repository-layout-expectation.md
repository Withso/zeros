# New documents need the repository-layout expectation

- Symptom: two worker handoffs went red in CI on
  `scripts/__tests__/repository-layout.test.ts` although `pnpm ci:plan` was
  green.
- Cause: lane selection only picks the layout lane; the test keeps a
  hard-coded sorted list of audited files.
- Rule: run the layout test before pushing any added or renamed file under an
  audited directory. When two open PRs each add a document, the second to
  merge adds both.
- Encoded in `skills/zstack-verify/SKILL.md` (Gotchas already paid for).
