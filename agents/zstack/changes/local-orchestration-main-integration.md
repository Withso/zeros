# Check transcript contracts when integrating Local orchestration

Symptom: merging the Local CLI with streaming persistence and startup notices
left paged CLI reads behind live output and repeated a failed notification
turn's explanation below its footer.

Cause: the new cursor read bypassed the streaming buffer's read barrier, while
startup-notice ownership still required a user prompt. Local notification
turns have a durable provider-turn ID and footer without a prompt bubble.

Rule: every transcript read must observe queued rows for its exact chat before
paging. Failure ownership follows the recorded provider turn, including turns
without a visible prompt; completed and cancelled turns cannot absorb a later
startup failure.

Encoded in `engine/db/__tests__/db.test.ts` (latest buffered insert/update,
stable cursor and isolation from another chat) and
`renderer/features/agent/__tests__/agent-error-notifications.test.ts` (failed,
completed and cancelled notification turns for Local Personal,
organization-local and cloud histories). Both regressions failed on the
unfixed combined tree before the fixes were applied.

Verification also found that the ChatView admission fixture mocked only the
session selector, while main's new transcript paint reads `getState` directly.
Keep store fixtures compatible with both APIs, and supply the provider-list
read, so the tests reach their admission assertions. This is encoded in
`shell/conversation/__tests__/local-link-admission.test.ts`.
