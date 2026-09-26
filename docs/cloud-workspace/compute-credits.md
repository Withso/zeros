# Managed compute credit contract

Managed Boat allocations require prepaid, finite compute leases. Customer
Daytona connections are charged by Daytona and never consume Zeros managed
credits. The existing hosted Daytona path remains an explicit compatibility
policy; qualifying it for managed credit billing requires its own reliable
usage meter and finite stop adapter. A new hosted provider fails closed.

The [Pro backend](pro-backend.md) automatically issues one monthly allowance
per eligible user: 500 standard-machine hours, recorded as a server-defined
receipt under the existing funding lock. Staff receive independently audited
complimentary Pro with the same limits. Payment collection remains a separate
integration. Deployed staff-pilot receipts remain historical evidence; overlapping
pilot periods block automatic issuance until an explicit cutover is resolved.

Credits are integer micro-US dollars (`1 USD = 1000000 micro_usd`). A Pro
funding receipt belongs to one user and explicit period, independent of any
organization. Reservations in multiple organizations conserve that single user
allowance. Joining another organization never duplicates it. The workspace owner
sponsors compute; a collaborator's action does not change the payer. Business
organization grants remain a separate ledger and cannot replenish Pro-backed
periods. Eligibility does not bypass the allowance issuer or ledger. At a
qualified 100,000 standard seconds per dollar, the monthly receipt is
`18000000` micro-USD. There is no rollover, automatic invoice collection,
customer overage or model-token allowance here.

## Allocation and settlement

The control plane reserves the entire forecast before sending create, resume
or renewal to the provider. The reservation covers the finite TTL plus a
request margin. A database claim prevents a superseded worker from extending
credit. Retries retain the allocation identity and request TTL. Unknown provider
outcomes retain their holds until independently reconciled.

A temporary create/resume failure can retry while its original lifecycle
intent, generation, payer and paid authority remain valid. The initial claim is
created atomically with the lease. An unconfirmed start retains its reservation
for at most 45 minutes from the original request, also bounded by its funded
window; retries never reset that deadline. A currently absent or still-archived
VM does not finalize a pending start. Stop and credit settlement check the
worker's live claim under the mutation lock, so a late provider response cannot
cancel or refund an allocation recovered by another worker.

Boat's weighted allocated seconds are metered cumulatively within each exact
period. The provider's reported price must match the configured versioned
policy. Workload CPU counters are not billing evidence. A repeated or older
watermark cannot debit twice. Confirmed future periods can fund a lease across
a boundary; an assumed future subscription renewal cannot.

The provider deadline and funded window also gate engine and human-service
authority. A lost control plane therefore cannot leave an indefinitely funded
VM. The worker renews only after metering and reserving the extension. A
nonrecoverable provider error, policy mismatch or exhausted balance starts a bounded final
checkpoint and stop. Near the deadline it stops directly, retaining the last
durable checkpoint. Budget enforcement never permanently deletes the VM.

A ready/busy workspace must also have a live current-generation engine before
its compute lease can renew. Expired engine authority stops compute even when
credit remains. Bootstrap uses the existing setup deadline; a failed workspace
cannot keep renewing under its initial provisioning allowance. Engine loss
does not authorize a replacement allocation or automatic prompt replay.

Final settlement requires an independently stopped/archived allocation and a
provider meter covering the stopped observation. A paused billing flag on a
running VM is insufficient. Permanent deletion waits for settlement while the
provider usage API is still available. Unused future reservations are released
without querying a future usage interval. A missing resource or an accepted
DELETE is not proof of absence or a zero bill. Unrecoverable final usage stays
visible as an operator reconciliation failure; it is never invented.

Actual usage beyond an authorization is recorded as platform exposure, not
customer debt. Later grants cannot retroactively charge that exposure. This
initial policy meters allocated compute. Provider snapshot/storage/network
charges and Zeros durable-object costs require separate operational budgets;
they are not silently debited as compute seconds.

## Configuration and rollout

Managed Boat requires `BOAT_COMPUTE_POLICY_ID` and
`BOAT_SECONDS_PER_DOLLAR`, pinned to an observed provider billing contract.
`BOAT_TTL_SECONDS` is the maximum renewable lease, from 60 through 3600 seconds.
The default minimum funded lease is the smaller of 600 seconds and that maximum.
The request margin is the configured operation timeout plus five seconds.
`none` is not a managed-compute deployment option.

Migration `0073_cloud_workspace_compute_leases.sql` is a controlled rollout:
stop old lifecycle workers, back up the database, and stop existing hosted Boat
allocations before applying it. Provision explicit credit receipts and deploy
the new reconciler before resuming. Do not run an older allocator alongside the
new spending boundary. A rollback must leave Boat allocations stopped and
cloud execution disabled; do not disable the credit gate to revive them.
Existing provider credentials and immutable image references stay unchanged.
The managed Boat and independent Daytona BYO deployment variables are listed in
the control plane's [environment example](../../apps/control-plane/.env.example).

## Grant operations

The operator command defaults to a read-only plan and requires an active
`platform_owner` on execution. Explicit `fundingScope` selects the user or
organization ledger. Receipt identities are global across users for individual
funding; changing their user, amount or period conflicts. No public HTTP route
can grant funds, set prices or submit provider billing evidence.

Prepare a private JSON document containing `channel`, `fundingScope`, `userId`,
`actorUserId`, `startsAt`, `endsAt`, `amountMicroUsd`, `policyId`, `idempotencyKey`
and `reason`. For Pro and the staff pilot, use `"fundingScope": "user"` and omit
organization fields. The root allowance follows that account across organizations.
For historical Organization funding, use `"fundingScope": "organization"` and include `organizationId`
and `expectedOrganizationSlug`; current membership and the exact slug are checked.
Manual receipts cannot top up an automatic monthly period. The following is a
historical pilot grant shape, not the Pro monthly issuer (replace all fixtures):

```json
{
  "channel": "alpha",
  "fundingScope": "user",
  "userId": "11111111-1111-4111-8111-111111111111",
  "actorUserId": "22222222-2222-4222-8222-222222222222",
  "startsAt": "2026-09-01T00:00:00Z",
  "endsAt": "2026-10-01T00:00:00Z",
  "amountMicroUsd": 20000000,
  "policyId": "pilot-budget-v1",
  "idempotencyKey": "approved-pilot-receipt-1",
  "reason": "Approved finite staff qualification allowance"
}
```

Older Business documents must add `"fundingScope": "organization"` and obtain
a fresh plan digest before replay. Their existing ledger receipt identity and
amount do not change; this never grants the same receipt a second time.

Use ISO timestamps with explicit offsets, the approved receipt amount, and an
audit reason of 16–512 characters. The channel must match Railway when present.
Configure `DATABASE_URL` securely and run:

```sh
CLOUD_COMPUTE_GRANT_FILE=/secure/grant.json pnpm --dir apps/control-plane cloud-compute:grant
```

Review the exact target and amount. Set `CLOUD_COMPUTE_GRANT_PLAN_SHA256` to the
returned digest, keep the same file and database, and run the command with
`--execute`. Repeating the same receipt reports `replayed` without granting twice.
A signed billing adapter may call the same ledger after independently validating
its receipt; subscription events alone are insufficient.

`GET /v1/organizations/:organization/cloud-compute-credits` returns at most the
100 most recent periods for the authenticated member only, with `Cache-Control:
no-store`. Paid cancellation does not hide the owner's balance; account or
membership revocation removes access. The public response excludes platform
exposure. It does not grant execution authority.

Health reports aggregate `compute_settlement_stalled`, `compute_lease_expired`,
and `compute_platform_exposure` signals without tenant identifiers. Operators
must investigate retained reservations using provider receipts. Never release
a hold because a worker timed out, or mark deletion complete from a 404 alone.
