// ──────────────────────────────────────────────────────────
// Chat thread identifier
// ──────────────────────────────────────────────────────────
//
// Shared id generator used by every surface that dispatches
// ADD_CHAT (spawn-default-chat, "+" menu, EmptyComposer). Keeping a
// single source ensures the format is consistent — `chat-<base36ts>-<rand>`
// is parsed nowhere, but the prefix is convenient for log grepping.
//
// Math.random is fine here: chat ids are not security identifiers.
// They only need to be unique within the local store; a 4-char
// random suffix is collision-safe at the rate a single user creates
// chats.

export function newChatId(): string {
  return `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}
