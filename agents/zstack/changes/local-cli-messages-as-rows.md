# Local CLI: an input is not a message, and "ready" is not proof of admission

A real multi-agent run on the Mac showed four gaps the unit tests missed:

- **Provider input is not presentation.** Agent messages and Zeros notes were
  user prompts on the wire, so the transcript showed them as user bubbles
  (labels and card JSON included). Stamp provenance at the engine
  (`localFrom` / `localNote`) and render from it; the provider keeps its
  labelled text. Never infer provenance from message text.
- **Persisted is not live.** A steer persisted only to SQLite reaches the open
  view at the next re-window, which the streaming owner skips until the turn
  ends. Anything the engine records on its own must be pushed as a whole row
  (`user_message_recorded`) to every view at once.
- **A gate that waits for idle never fires for a coordinator.** Titles waited
  for `ready`; an orchestrating chat goes straight from one turn into the
  next. Use proof of admission (the agent answered the prompt), and only the
  window's opening row — a re-windowed tail starts mid-history.
- **A tab is a promise that an agent runs.** A chat created before its signed-
  out agent failed left empty tabs that still sent a prompt. Check the
  provider's own gate before writing anything, announce a new tab only once
  its agent started, and remove one that never connected; keep the tab when
  the provider answered (a rate limit).

Also, from the UI half: metadata consumers need the renderer's own mutation
bus (DB_CHANGED skips the originator), linkifiers must not nest interactive
controls inside sanitized HTML, and per-gesture undo tests must model
separate gestures.

Encoded in `local-orchestration/__tests__/service.test.ts` (signed-out agent,
never-connected removal, rate-limit kept, note/agent presentations),
`local-orchestration/__tests__/engine-ports.test.ts`,
`apps/desktop/src/engine/__tests__/local-orchestration-engine.test.ts` (live
steer and note rows), `renderer/features/agent/__tests__/chat-title.test.ts`,
`local-message-turns.test.ts`, `local-links-provider.test.ts` and
`local-links.test.ts`.
