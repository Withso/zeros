/** Child arrival must not override the user's disclosure choice. */
export function cursorTaskOpenState(
  userToggled: boolean | null,
  _childCount: number,
): boolean {
  return userToggled ?? false;
}
