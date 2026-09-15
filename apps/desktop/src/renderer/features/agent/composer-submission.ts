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
