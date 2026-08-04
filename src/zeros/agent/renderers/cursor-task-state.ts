/** Before the user expresses a preference, reveal the task as soon as Cursor's
 * first live child event arrives. An explicit expand/collapse stays sticky
 * across every later poll frame. */
export function cursorTaskOpenState(
  userToggled: boolean | null,
  childCount: number,
): boolean {
  return userToggled ?? childCount > 0;
}
