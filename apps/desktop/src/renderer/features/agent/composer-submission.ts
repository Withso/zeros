/** An attachment transfer can outlive further typing. Only clear the document
 * that was submitted; a newer draft remains owned by the composer. */
export function isSubmittedComposerDocument(
  submitted: object,
  current: object | undefined,
): boolean {
  return (
    current !== undefined &&
    JSON.stringify(submitted) === JSON.stringify(current)
  );
}

/** Whether a send retires the chat's saved draft: when the composer's own
 * document went out unchanged, or when another surface sent text for it. A
 * message sent beside the composer (a transcript reply) keeps the draft. */
export function sendClearsChatDraft(input: {
  override: boolean;
  keepDraft: boolean;
  submittedUnchanged: boolean;
}): boolean {
  return input.submittedUnchanged || (input.override && !input.keepDraft);
}
