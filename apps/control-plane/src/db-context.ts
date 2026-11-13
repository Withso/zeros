// Transaction-local only: a pooled backend must not lend this protocol marker
// to an older replica. It is compatibility metadata, not user authorization.
const protocol = "set_config('app.cloud_execution_protocol', '1', true)";
export const PROTOCOL_DATABASE_CONTEXT = `SELECT ${protocol}`;
export const SYSTEM_DATABASE_CONTEXT = `SELECT set_config('app.system', 'on', true), ${protocol}`;
export const USER_DATABASE_CONTEXT = `SELECT set_config('app.user_id', $1, true), ${protocol}`;

const ownership = new WeakSet<object>();
export function readCloudTeamOwnership(value: string | undefined): boolean {
  const flag = value?.trim();
  if (flag && flag !== "0" && flag !== "1") throw new Error("Invalid environment: ZEROS_CLOUD_TEAM_OWNERSHIP must be 0 or 1");
  return flag === "1";
}
export function configureCloudTeamOwnership(pool: object, enabled: boolean) {
  if (enabled) ownership.add(pool); else ownership.delete(pool);
}
export function cloudTeamOwnershipEnabled(pool: object): boolean { return ownership.has(pool); }
function ownershipDatabaseContext(context: string, enabled: boolean): string {
  // This is the channel's write switch, not an RLS or client protocol marker.
  // Explicit zero prevents an inherited connection setting from enabling it.
  return `${context}, set_config('app.cloud_team_ownership', '${enabled ? "1" : "0"}', true)`;
}
export const DATABASE_CONTEXT_STATEMENTS: ReadonlySet<string> = new Set(
  [SYSTEM_DATABASE_CONTEXT, USER_DATABASE_CONTEXT, PROTOCOL_DATABASE_CONTEXT].flatMap(context =>
    [context, ownershipDatabaseContext(context, false), ownershipDatabaseContext(context, true)]));
export function configuredDatabaseContext(pool: object, context: string): string {
  return ownershipDatabaseContext(context, ownership.has(pool));
}
