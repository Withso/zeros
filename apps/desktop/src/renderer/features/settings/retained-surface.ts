/** A retained panel may keep local state while hidden, but its portalled
 * overlays must become inert immediately when that panel loses ownership. */
export function retainedDialogOpen(
  surfaceActive: boolean,
  requestedOpen: boolean,
): boolean {
  return surfaceActive && requestedOpen;
}
