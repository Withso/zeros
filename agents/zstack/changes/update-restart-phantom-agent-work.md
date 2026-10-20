# Update restarts must wait for agent work, not session status

Symptom: with nothing running, the "New update available" toast offered
"Restart when idle". Once armed, the deferred restart never fired. The required
update screen had the same gate and could hold its automatic restart forever.

Cause: both update surfaces counted any `warming` or `reconnecting` slot as a
running agent. Every opened chat warms its session before anything is sent,
and idle chats rest in `reconnecting` after an agent exit or a superseded bind
until their next use. The toast also ignored `pendingLocalTurns`.

Rule: an app-level "is agent work running?" gate reuses
`agentSessionHasActiveWork` with `pendingLocalTurns` (now
`anyAgentHasActiveWork`). An open `streaming` turn still counts, and so does a
cloud send in `cloudSendWait: waiting`, which exists only in the renderer until
dispatch and sets no pending turn. A bare admission status does not count.

Encoded in `update-restart-agent-work.test.ts`, which drives the real store
producers for Local and cloud chats, and in eval case
`update-restart-phantom-agent-work`.
