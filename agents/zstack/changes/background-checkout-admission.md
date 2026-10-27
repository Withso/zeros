# Fence background checkout moves on every kind of work, not only commands

- **Symptom.** A background fast-forward could move a new branch after work
  had started. The HTTP prompt inbox and the metadata-only `git.changeTarget`
  bypassed the bridge's activity boundary.
- **Cause.** Activity admission was attached to bridge requests and the Git
  command runner. Durable prompt delivery and metadata writes reach the
  workspace without either.
- **Rule.** Admit background checkout mutation only through one fence that
  agent sessions, terminals, file writes, Git mutations, setup and the durable
  prompt inbox all pass before they start. Keep passive reads outside it, and
  test each entry point with the mutation held.
- **Encoded in.** The held-boundary and passive-read cases in
  `apps/cloud-worker/src/workspace/__tests__/checkout.test.ts` and
  `src/__tests__/prompt-inbox.test.ts`.
