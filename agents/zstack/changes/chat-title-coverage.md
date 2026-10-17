# Name chats from the source of truth, not from what one view has loaded

- Symptom: Codex chats stayed "Untitled"; Cursor and Claude sometimes did, and
  chats an agent started or messaged never got a title.
- Cause: titles came only from an open chat's in-memory window. Codex puts a
  startup notice before the first prompt, and a "first row must be the prompt"
  guard (added so a re-windowed tail would not name the chat) then refused it.
  Unopened tabs never ran the request; one failed request (busy, timeout, a
  two-word reply) was never retried and the service cached the failure.
- Rule: derive "the first prompt" from durable history (`chats.titleSeeds`:
  first non-note user row, answered or turn ended), run naming as an
  app-level, rate-limited service for every untitled Local chat, retry
  transient failures under fresh request ids, and fall back to the prompt's
  own words rather than leave a chat unnamed.
- Encoded in `db/__tests__/chat-title-seeds.test.ts`,
  `renderer/features/agent/__tests__/chat-title-backfill.test.ts`,
  `chat-title-request.test.ts` and `chat-title.test.ts`.
