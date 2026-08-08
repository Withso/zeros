// The composer has two deliberately short states. A pristine Untitled chat
// teaches the two context gestures; after its first prompt, the editor becomes
// a compact follow-up surface. Keeping the copy in a pure helper makes the
// first-send boundary explicit and shared by tests rather than inferred from
// TipTap decoration markup.

export const NEW_CHAT_COMPOSER_PLACEHOLDER =
  "Build, Design, / for commands, @ for context";
export const FOLLOW_UP_COMPOSER_PLACEHOLDER = "Send follow up";

export function resolveComposerPlaceholder(
  conversationStarted: boolean,
): string {
  return conversationStarted
    ? FOLLOW_UP_COMPOSER_PLACEHOLDER
    : NEW_CHAT_COMPOSER_PLACEHOLDER;
}
