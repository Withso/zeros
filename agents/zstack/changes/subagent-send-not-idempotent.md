# A brief sent twice

The master sent a subagent its next work package and parsed the reply with a
filter for `.data`. Conductor's `message create --json` answers with top-level
`messageId`, `state` and `deepLink`, so the filter read a successful send as a
failure, and the "retry" delivered the same brief a second time into the
running turn.

Rule: read the host's documented reply shape before treating a send as failed;
on doubt, read the session transcript instead of resending; pass the host's
message id flag (Conductor: `--message-id <uuid>`; a non-UUID is refused with HTTP 400 and nothing is sent) so a retry is idempotent. The
Zeros Local CLI applies the same rule to agents: `--request-id` on create and
send, retry only with the same id after an unknown outcome.

Encoded in `skills/zstack` (master plus subagents) and the bundled
`zeros-local-cli` skill.
