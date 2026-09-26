# Pro cloud backend

This is the backend contract for individual Pro launch. It adds migrations
`0101`–`0104`; it does not enable a deployment, apply hosted migrations, or ship
desktop UI. Business pricing, seats and collaboration policy remain deferred.
See [qualification status](qualification-status.md) for deployed evidence.

## Authorization and sharing

Every new cloud workspace belongs to a non-Personal Organization and Team. Its
creator must be a current member, have repository access, and hold individual
Pro. Organization entitlements and seats are not required. Organization creation
remains restricted to standing `platform_owner` and `developer` staff through
both API routes. The Organization cloud switch remains an operational veto.

The creator/owner is the immutable sponsor. Collaborators cannot choose a payer,
pool allowances, or acquire another allowance by joining. Existing
Organization-funded billing epochs retain their historical authorization and
funding model; the migration does not convert them to individual Pro.

Every collaborator, including Read-only users, needs their own active Pro.
Verified invitations can grant exact-workspace access across Organizations
without adding Organization or Team membership. Private workspaces remain
private. Organization sharing grants eligible members Read-only access by
default, including Organization administrators.

Pro workspaces have ten writer slots, including the owner. Slots count assigned
people and pending Write invitations, not devices, online users, or Organization
seats. All execution-capable roles count: owner, manager, developer and prompter.
Normal Write access does not grant invitation or credential management.
Read-only cannot edit, prompt, approve execution, open terminals/SSH or
interactive previews, or start compute. Existing narrow cleanup/recovery paths
remain available when paid authority is withdrawn.

The Organization/workspace lock order and bounded slot primary key serialize
invitations, acceptance and direct promotion. Verified aliases share a slot;
replacing a reservation invalidates its earlier invitation. Expiry, revocation
and downgrade release capacity. Pro lapse withdraws access but retains an
otherwise valid assignment. Fingerprints include assignment identity, so a
removed and re-added writer cannot resurrect an old session or queued command.
Membership removal invalidates earlier guest grants and invitations.
Accepting an invitation replaces any earlier explicit collaborator role with
the invitation's bounded grant, including for Organization members. Expiry
cannot leave a permanent Write assignment or revive an earlier role.

There is no total Read-only guest or invitation limit for Pro. HTTP throughput
limits remain. Collaboration reads use separate UUID keyset cursors and pages
of at most 100 for members, guests and invitations:

- `GET /v1/cloud-workspaces/:workspace/collaborators` accepts `pageSize`,
  `memberCursor`, `guestCursor`, `invitationCursor`; returns next cursors and
  `writers: { limit: 10, used, available }`.
- `PATCH /v1/cloud-workspaces/:workspace/collaborators/:user` accepts
  `{ "role": "viewer" | "developer" }` for Read-only/Write.
- Existing sharing, invitation, acceptance and revocation routes remain.
  Invitation acceptance requires the recipient's own verified identity and Pro.

Deletion invalidations retain all external recipients in a separate durable
outbox table and publish at most 100 recipients per transaction. Hard deletion
of the host does not silently drop viewers beyond the first page; account
erasure scrubs recipient identities from pending delivery.

Migration `0103` marks previously shared, account-funded workspaces
`pro_sharing_ready=false`, advances their access revision, and assigns only the
owner. It preserves historical grants without arbitrarily selecting nine more
writers. The owner explicitly assigns writers and confirms sharing through the
sharing API before restoring collaboration. Historical Organization-funded
workspaces keep their prior sharing behavior.

## Entitlements and monthly funding

`staff_pro_benefits` records complimentary Pro independently of paid
`account_entitlements`. Standing staff grants/revocations create owner-only
audit rows, including migration backfill. Removing staff status cannot overwrite
paid Pro. The effective entitlement prefers current paid Pro for authority;
the allowance issuer can independently use an active staff benefit as renewal
evidence. Both sources together still produce one allowance.

The automatic allowance is 1,800,000 standard-machine seconds per user per
monthly period (500 hours at 4 vCPU / 8 GiB). Larger machines consume faster.
`managed_compute_pro_accounts.anchor_at` records the first activation and cannot
be reset by the runtime role. UTC boundaries preserve the original day/time,
clamping short months independently: January 31 → February 28 → March 31.
Regrant, staff/paid changes, Organization changes and entitlement revisions do
not reset the cycle or replenish the current period.

An entitlement trigger queues reconciliation; the bounded background worker and
lease admission repair issue under the existing per-user funding lock. There is
one automatic receipt per `(user, period start)`, with policy, price and
entitlement evidence. The server fixes the amount, source and period; no public
grant endpoint exists. Usage GET never issues funds.

At `BOAT_SECONDS_PER_DOLLAR=100000`, the allowance is 18,000,000 micro-USD ($18
compute at full consumption). This is not a total infrastructure cost. Existing
integer ledger accounting, cross-Organization conservation, finite leases,
cumulative usage, settlement and platform exposure remain in effect. Policy and
rate changes fail closed within an existing period; later periods may use the
new qualified price. Provider metering already applies the machine multiplier.

There is no rollover, expired-month catch-up, top-up of an automatic period, or
customer overage. An open-ended paid/operator activation funds one period; a
new period needs fresh renewal evidence, paid-through validity, or current
audited staff eligibility. Cancellation honors an explicit paid-through date.
Within a finite lease's horizon, a confirmed next period can be issued ahead
of the boundary and reserved separately. An unconfirmed next period cannot fund
a lease. Existing overlapping manual user or Organization pilot periods block
automatic issuance; operators must resolve that cutover explicitly without
rewriting historical receipts or debits.

The allowance worker starts only with the existing cloud background-worker
switch and managed compute policy. It processes at most 50 accounts per tick
(60 seconds), retries unavailable accounts after an hour, and queues changes
immediately. Admission repairs a missing allowance synchronously. A process
restart or concurrent worker cannot issue a second receipt.

## Customer response boundary

`GET /v1/cloud-compute-usage` returns only the authenticated account's coherent,
no-store snapshot:

```json
{
  "state": "ready",
  "usedPercent": 25,
  "reservedPercent": 10,
  "availablePercent": 65,
  "resetsAt": "2026-10-26T12:00:00.000Z",
  "asOf": "2026-09-26T12:00:00.000Z"
}
```

States are `ready`, `exhausted`, `pending`, `ineligible` and `unavailable`.
Missing/unavailable balances have null percentages. Percentages are bounded and
sum to 100 when known. Settled/cumulative debits count as used; open reservations
count separately. Moving allocations between Organizations is not usage. No
hours, money, grant amount, account selector or supplier data is returned.
Existing raw credit routes retain their monetary compatibility contract.

Workspace documents expose `capabilities` (`canWrite`, `canManage`, `canStart`,
`startUnavailableReason`). These are a current availability snapshot, not an
authorization token or reservation. Start rechecks live membership, paid
authority, quotas, minimum finite-lease funding and runtime state under locks.
Collaborators see an availability reason, never the sponsor's global balance.

Public workspace/connection documents omit infrastructure provider names,
targets and image references. Stored failures and customer cloud HTTP errors
use stable neutral codes/messages rather than diagnostic text or details.
Management overview uses `compute`, with a fixed neutral display name.
Internal provider records, journals, metering and encrypted credentials retain
their existing identities. Agent/model provider choices remain product data.

The old public `/access/ssh` and `/access/tunnels` creation routes now return
`409 cloud_workspace_runtime_connection_required`; they cannot return supplier
hosts or credentials. Clients use the existing actor-aware `/runtime/services`
relay. Existing grant revocation and local tunnel activation remain available.
Desktop wiring for this public contract migration is a separate phase; cloud
execution stays disabled until the new client path is qualified.

## Safety defaults and rollout

Migration `0102` and both Organization creation routes insert missing `pro-v1`
defaults: 10 workspaces, 5 running, 40 vCPU, 80 GiB RAM, 1,500,000 MiB VM storage,
100 GiB Organization objects and 20 GiB workspace objects. VM disk includes the
qualified 70,225 MiB image plus replacement headroom. These finite safety caps
are separate from subscription eligibility and never issue credits. Explicit
operator limits and operational disable switches are preserved. Quota/storage
operator tools no longer require a purchased Organization entitlement; setting
an override clears the default-policy marker and retains the existing audit.

Before deployment, inventory existing grants and pilot periods, review the
sharing cutover, and run migrations through the controlled migration process.
`0101` and `0103` require controlled downtime. Do not run an old allocator or
authorization implementation alongside the new policy. Staff receive the
complimentary benefit when these migrations are applied; no hosted entitlement
changes are part of this backend implementation. Alpha enablement, its separate
runtime key/storage configuration, desktop UI, Beta and Production remain
separate qualification steps.
