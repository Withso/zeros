# Make the path agents actually take work; prose does not steer them

- Symptom: every Codex coordinator's first `zeros local whoami --json` failed
  with `NO_CAPABILITY`, then worked on an escalated retry (children raised
  permission cards for the same escalation). Leading the brief and skill with
  the in-process `zeros_local` tool did not change it: the next real run read
  the new skill and still went to the shell first.
- Cause: Codex runs shell commands in its workspace sandbox with network off
  outside Full Access, so the CLI's loopback connect is denied; models prefer
  the shell and only escalate after a failure, whatever the instructions say.
- Rule: when agents keep taking one path, make that path work instead of
  documenting another. The CLI now falls back, only on a denied connect, to a
  private per-execution folder under the engine's `$TMPDIR` that the sandbox
  keeps writable (`dropbox.ts`): atomic request, claim by rename, bearer
  checked against the folder's own execution, unclaimed requests withdrawn and
  reported as not sent. Keep the in-process tool for read-only shells.
- Encoded in `local-orchestration/__tests__/dropbox.test.ts`, `cli.test.ts`
  (first attempt through the folder when loopback is denied; nothing sent when
  unclaimed; tool hint when the folder is unwritable) and `admission.test.ts`.
