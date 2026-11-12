// Transaction-local only: a pooled backend must not lend this protocol marker
// to an older replica. It is compatibility metadata, not user authorization.
const protocol = "set_config('app.cloud_execution_protocol', '1', true)";
export const PROTOCOL_DATABASE_CONTEXT = `SELECT ${protocol}`;
export const SYSTEM_DATABASE_CONTEXT = `SELECT set_config('app.system', 'on', true), ${protocol}`;
export const USER_DATABASE_CONTEXT = `SELECT set_config('app.user_id', $1, true), ${protocol}`;
