/** The immutable image helper communicates success/failure as structured data;
 * arbitrary command output is never part of that protocol. Keep this boundary
 * fail-closed if a provider or future helper nevertheless supplies text. */
export function sanitizeCloudWorkspaceSetupLog(value: string): string {
  return value.length > 0 ? "[cloud workspace setup output withheld]" : "";
}
