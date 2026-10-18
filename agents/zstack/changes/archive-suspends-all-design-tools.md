# A scoped gate was only reachable from its own test

Archiving one Local workspace failed a Codex prompt in another workspace with
"The operation was aborted." before the provider was called. Archive, delete,
restore and recover are not lifecycle-gated ops, so `lifecycleMutationWorkspaceId`
is null for them and the owner-scoped Design transition added for them was never
selected: every one took the app-wide gate, which suspends Design grants in every
chat. Prompt preparation then threw the suspension's reasonless abort, which Bun
words as "The operation was aborted.", and the engine stored it as an untyped,
unrecoverable `protocol-error`.

Rule for bug-fix: test a scoped gate through the real request dispatcher for every
op it names; calling the gate helper directly cannot show that dispatch never
reaches it. A suspension must hold prompt and steer preparation until it resumes,
while Stop and disposal still end the wait. Give aborts a reason, and type any
failure that proves the prompt never reached the provider so the sender can
resend it.

Encoded in `workspace-lifecycle-design-scope.test.ts` (Local and cloud dispatch,
same-owner queueing), the conversation-tools transition tests, and the registry
and gateway preparation tests. Eval: `archive-suspends-all-design-tools`.

Verification gotcha: on macOS the default `TMPDIR` is reached through the `/var`
symlink, so path-safety suites (zstack source/runner, several cloud fixtures)
failed locally with `*_unsafe` or "not canonical" before and after the fix. With
`TMPDIR` under `/private/tmp` the zstack suites pass; Linux-only cloud fixtures
still fail on macOS. Encoded in `zstack-verify`.
