# Individual Pro operator access

Billing integration is deferred during the staff pilot. `account-pro:manage`
provides an explicit, database-owner operation to grant or revoke an individual
account's Pro entitlement. It does not grant a staff role, add organization
membership, activate a Business seat, or supply compute credits. Runtime access
still requires the staff pilot gate and all ordinary workspace authorization.
One Pro account can participate in multiple Pro organizations with its existing
personal entitlement and compute allowance.

Use a direct primary migration connection with `DATABASE_MIGRATION_ROLE` set to
the stable object owner when the login rotates. Never give that connection to the
API service. The actor must be an active `platform_owner`; the actor need not
already have Pro. A grant requires an active subject and a matching expected email. Revocation
also works for suspended or deletion-pending subjects; erased accounts cannot
receive a new change.
External billing and migration-owned entitlements require their own authority
transition and cannot be overwritten by this operator.

Save a private JSON document, replacing these synthetic values:

```json
{
  "operationId": "11111111-1111-4111-8111-111111111111",
  "channel": "alpha",
  "subjectUserId": "22222222-2222-4222-8222-222222222222",
  "expectedEmail": "pilot@example.test",
  "actorUserId": "33333333-3333-4333-8333-333333333333",
  "enabled": true,
  "validFrom": "2026-09-20T00:00:00Z",
  "validUntil": "2026-09-21T00:00:00Z",
  "reason": "Authorize the explicit staff pilot qualification period"
}
```

`validUntil` may be `null` for an explicitly indefinite grant. Set `enabled` to
`false` and use a new operation ID to revoke; the cancelled entitlement remains
with an advanced revision. Use a non-personal operational reason because it is
stored in owner-only audit evidence. The expected email is checked but is not
stored in that evidence.

Run a plan first:

```sh
CONTROL_PLANE_ACCOUNT_PRO_CHANNEL=alpha \
ACCOUNT_PRO_CHANGE_FILE=/secure/account-pro-change.json \
pnpm --dir apps/control-plane account-pro:manage
```

Review the exact previous and next state. Execute with the returned hash:

```sh
CONTROL_PLANE_ACCOUNT_PRO_CHANNEL=alpha \
ACCOUNT_PRO_CHANGE_FILE=/secure/account-pro-change.json \
ACCOUNT_PRO_PLAN_SHA256=<reviewed-plan-sha256> \
pnpm --dir apps/control-plane account-pro:manage --execute
```

On Railway, `RAILWAY_ENVIRONMENT_NAME` selects the channel. Approvals bind the
host, direct port, database, routed login, effective migration owner, subject,
actor, account authorization revisions, existing entitlement, and audit revision.
A different branch or intervening change requires a new plan. Repeating the same
committed operation with its original approval returns its receipt without
reapplying authority; an operation ID cannot identify different input. Do not
copy an old approval into another environment or delete a revoked row to reuse
its revision.

The entitlement, account authorization revision, security event, and evidence
commit together. The application role cannot directly write personal
entitlements or operator evidence. Existing paid-authority triggers
schedule resource reconciliation, and live actor/delegation checks observe the
new entitlement revision. Revocation does not transfer compute ownership or
revoke another person's account. Account erasure explicitly removes its
entitlement and related operator evidence after the lifecycle anonymizes the
account; the retained user UUID is not a substitute for this cleanup.

After granting Pro, provision only the intended organization quota and object
storage limits, then issue a separate user-scoped compute grant. See
[compute credits](compute-credits.md), [database qualification](database-qualification.md),
and [infrastructure operations](infrastructure-and-operations.md).
