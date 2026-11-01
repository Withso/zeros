import type pg from "pg";

/** Test fixture: an active, open-ended operator Pro entitlement for each account. */
export async function grantTestPro(db: pg.Pool | pg.PoolClient, ...userIds: string[]): Promise<void> {
  for (const userId of userIds) {
    await db.query(
      `INSERT INTO account_entitlements (user_id, plan, status, cloud_workspaces_allowed, source)
       VALUES ($1, 'pro', 'active', true, 'operator')
       ON CONFLICT (user_id) DO UPDATE SET plan = 'pro', status = 'active', cloud_workspaces_allowed = true,
         valid_from = least(account_entitlements.valid_from, now()), valid_until = NULL`,
      [userId],
    );
  }
}
