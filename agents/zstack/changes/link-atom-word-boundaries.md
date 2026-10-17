# An inline atom that serializes to a token must keep its word boundaries

- Symptom: a pasted chat or workspace link rendered as a muted "Chat" /
  "Workspace" pill, and the agent got `NOT_FOUND` for a workspace the user had
  just linked.
- Cause: the composer's link atom serialized to its bare URL, and text typed
  right against the atom (which looks spaced on screen) joined it:
  `…/ws_c952b2-russet` + `what` became the id `ws_c952b2-russetwhat`. The
  bubble, the link share and the agent all read that wrong id.
- Rule: when an editor atom becomes text on the wire, add the separator the
  screen implies wherever the neighbouring text would extend the token, and do
  it identically for send and copy.
- Encoded in `renderer/features/agent/__tests__/composer-local-links.test.ts`
  ("separates text typed right against a pasted link").
