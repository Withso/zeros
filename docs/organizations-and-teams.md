# Organizations, teams, and workspace ownership

This document defines the tenant hierarchy shared by the control plane,
desktop application, browser dashboard, and future cloud-workspace service.

## Product hierarchy

```text
Account
├── Personal (permanent; one per account)
│   └── Default team (persisted implementation detail)
└── Organization (zero or more)
    └── Default team (exactly one live team for now)
        └── Members
```

An organization is the tenant, billing, invitation, policy, and workspace
ownership boundary. A team is a child grouping inside one organization. Team
IDs must never be accepted where an organization ID is required.

Personal is a Zeros-only product root and never creates a WorkOS Organization.
Every collaborative Zeros Organization creates exactly one WorkOS
Organization, correlated by the Zeros UUID in WorkOS `external_id`. WorkOS
organization membership provides the coarse identity lifecycle; Zeros child
teams, billing, entitlements, repository grants, and workspace authorization
remain Zeros-owned.

The initial UI exposes one default team and rejects creation of additional
teams with `multiple_teams_not_available`. The schema already supports more
teams so that enabling them later is a capability change, not another tenant
identity migration.

## Personal

Every authenticated account owns one live Personal organization. Signup and
every subsequent authenticated request idempotently ensure all four records
exist: Personal, its owner membership, its default team, and the corresponding
team maintainer membership. This repairs interrupted imports without making
page rendering a provisioning side effect.

Personal has these invariants:

- its visible name comes from the identity provider when available and falls
  back to `Personal`;
- it cannot be renamed or deleted through the product;
- it cannot invite other members or persist organization settings remotely;
- it is always local-workspace-only; and
- its owner cannot leave or be removed.

The child default team keeps the relational model uniform, but Personal is not
a collaborative organization and does not expose Members, Teams, or Billing UI.
Personal workspace configuration stays on the device.

## Plans and billing ownership

Plan and billing state belongs in Zeros/Stripe, never in WorkOS and never in an
AuthKit token. Authentication establishes identity; every billable operation
loads current entitlements transactionally from the control plane.

| Plan       | Tenant model | Seat purchaser | Teams | Cloud workspace rule |
| ---------- | ------------ | -------------- | ----- | -------------------- |
| Free       | Personal only | none | none in product UI | local only |
| Pro        | Personal plus an optional Pro organization | each collaborating account holds its own active Pro entitlement | one default team initially | cloud workspaces belong to that Pro organization; initial collaboration cap is five independently entitled Pro accounts |
| Business   | Business organization | organization buys centralized active-member seats | multiple child teams | cloud workspaces are organization-owned and team-scoped |
| Enterprise | Business model plus enterprise policy | organization contract/central billing | multiple child teams | Business behavior plus SSO/SAML, SCIM/Directory Sync, policy, audit, and contractual controls |

Business seat billing is organization-level, not team-level. One person with
membership in three teams consumes one active seat in that organization, not
three. Teams allocate work and access; they are not separate billing accounts.
If a customer needs separate purchasing, legal ownership, SSO policy, or data
retention, create a separate organization instead of overloading a team.

A Pro organization is still a real collaborative organization and therefore a
separate WorkOS Organization. Its owner does not buy a shared seat pack: every
active collaborator must independently qualify for Pro. The membership cap is
a product entitlement enforced by Zeros before sending a WorkOS invitation or
membership command. Upgrading that same tenant to Business changes billing and
team capabilities; it does not change the organization ID or move workspace
data.

Recommended durable billing records are an organization subscription, account
entitlements, organization seat assignments, and metered compute grants. Keep
seat entitlement separate from compute quota: a paid seat answers “may this
person collaborate?”, while cloud hours/CPU/storage answer “how much can this
tenant run?”.

## Organizations and roles

A user-created organization can own local workspaces and is eligible to own
cloud workspaces. Eligibility metadata is not an entitlement: provisioning
must still enforce the current plan, quota, repository access, and actor role.

Organization roles are `owner`, `admin`, and `member`:

| Operation                   | Owner                         | Admin | Member |
| --------------------------- | ----------------------------- | ----- | ------ |
| Rename organization         | yes                           | yes   | no     |
| Delete organization         | yes                           | no    | no     |
| Invite or revoke invitation | yes                           | yes   | no     |
| Change owner membership     | yes                           | no    | no     |
| Manage admin/member roles   | yes                           | yes   | no     |
| Leave                       | yes, if another owner remains | yes   | yes    |

The last owner cannot be demoted, removed, or leave. Invitations are
organization-scoped, single-use, expiring, and must be accepted by the exact
authenticated email address. Acceptance also adds the user to the live default
team. An existing stronger organization role is never weakened by accepting a
later invitation.

Child-team roles are deliberately narrower: `maintainer` and `member`.
Organization owners and admins are maintainers of the default team; organization
members are team members. Composite foreign keys enforce that a team belongs
to the stated organization and that every team member is already an
organization member.

WorkOS roles mirror only the coarse organization roles (`owner`, `admin`,
`member`). Zeros must not encode child-team membership or billing entitlement
into those roles. WorkOS-originated membership/role/deletion events update the
local projection and authorization revisions. Zeros-originated admin changes
commit locally with a durable provider command. A directory-managed membership
is marked `scim` and can be changed only through the enterprise identity
provider; Zeros local controls return `directory_managed_membership`.

Deletion has two scopes: deleting/removing one organization membership revokes
only that organization's grants and retains Personal/other organizations;
deleting the WorkOS User disables the whole Zeros authentication principal and
all sessions while preserving product data for reviewed recovery.

## Workspace placement

Desktop workspace rows carry two additive fields:

- `organization_id`: the tenant root that owns the workspace; and
- `placement`: `local` or `cloud`.

The SQLite constraint rejects a cloud placement without an organization ID.
Existing rows migrate as `organization_id = NULL, placement = 'local'`; a null
owner is the compatibility representation of legacy Personal data. On an
account's first hierarchy-aware organization snapshot, the desktop normalizes a
persisted promoted-Team selection to Personal so those legacy rows remain
visible. After hierarchy ownership has been confirmed, the selected owner may
be restored from account history during a cold refresh. Every local creation
path, including adopted worktrees and branch/PR workspaces, snapshots that
owner at intent time and persists its ID. Changing the switcher while an
asynchronous create is preparing cannot retarget that operation. Home,
Dashboard, repository, tab, pending-create, and archive collections are
filtered by the selected owner. Legacy null-owned rows appear only in Personal;
organization-owned rows match their exact organization ID.
After a confirmed leave or deletion, local rows from the retired organization
are reassigned to that account's Personal tenant. Bounded per-account
membership tombstones make the repair idempotent and catch a workspace create
that finishes just after the membership change. Cloud rows are never adopted
locally; their cleanup remains a server-side provisioning concern.
Existing crash-recovery seeds are rewritten with the same Personal owner, so a
later database rebuild cannot resurrect the departed organization identity.

Cloud provisioning is not implemented by this hierarchy change. When it ships,
the create path must reject Personal before dispatch and re-authorize the
organization, membership, capability, plan, and quota on the server.

### Local and cloud are execution modes, not movable containers

Do not implement a destructive “move workspace between local and cloud”
operation. Local and cloud workspaces have different trust, persistence, and
collaboration semantics:

- a local workspace is a device-owned checkout. Its path, conversations,
  uncommitted files, and existence are not uploaded merely because the user is
  viewing it under a Pro/Business organization context;
- a cloud workspace is a server record with an immutable Zeros ID,
  `organization_id`, `team_id`, creator, repository binding, generation,
  policy, and provider resource. Authorized team members can discover it; and
- switching the UI organization never retargets either kind of workspace.

Use explicit copy-like workflows instead:

1. **Create cloud from local.** Reauthorize the destination organization/team,
   plan, seat, repository, quota, and actor role. Create a new cloud workspace
   from a durable remote repository plus exact commit/branch. Keep the local
   workspace. Transferring uncommitted changes requires a separate reviewed,
   encrypted snapshot/patch feature; it is never implicit.
2. **Open cloud locally.** Clone/check out the cloud workspace's repository and
   exact revision into a new local workspace. Record an optional
   `source_cloud_workspace_id` for navigation, but do not change or hide the
   shared cloud workspace. Subsequent local edits stay private until the user
   explicitly pushes or shares them.
3. **Fork cloud.** Creating an independent cloud copy produces a new workspace
   ID and generation with explicit destination ownership. It is not a move and
   does not steal collaborators from the source.

In a Pro organization, the initial single default team means every active org
member can discover its cloud workspaces. In Business/Enterprise, each cloud
workspace belongs to one child team; team members can discover it and
organization owners/admins receive only the explicitly defined administrative
visibility. Cross-team sharing must be an explicit grant, not a side effect of
being in the same organization.

When organization access is removed, server credentials and endpoint grants
are revoked immediately and cloud APIs deny the member. A checkout already on
their device cannot be remotely erased; it becomes a private local workspace
under Personal and no longer receives organization secrets or cloud access.
This limitation must be clear to enterprise customers and complemented by
repository/provider revocation and, where required, managed-device controls.

### Cloud ownership invariants

- Every cloud workspace has exactly one non-Personal `organization_id` and one
  live `team_id` belonging to that organization.
- Repository authorization, chat/data rows, artifacts, endpoint grants,
  usage, and billing dimensions carry the same organization/workspace scope.
- All reads and mutations reauthorize current account, organization, team,
  plan, and resource generation on the server; client switcher state is never
  authority.
- Organization/team deletion first blocks creation/wake and revokes grants,
  then reconciles/archive-deletes provider resources according to retention.
- A WorkOS outage may pause create/wake, invite, or membership convergence but
  never grants access and never prevents safe stop/archive/delete cleanup.

## Client and management boundaries

The desktop Home rail owns the active-organization switcher. It can select
Personal or an organization, but creation, membership, billing, and destructive
organization management open `app.zeros.build` in the system browser. The
desktop Settings surface intentionally contains no parallel administration UI.

The signed-in browser root is the management dashboard. Auth tokens remain in
the server-side KV session. Browser JavaScript calls a same-origin, JSON-only,
route-allowlisted proxy; mutation requests require the same origin and the
dashboard request header. The dashboard retains exact organization/section
snapshots during revalidation and disables controls the actor cannot use.

## API and serialized compatibility

`GET /v1/me` returns `organizations` in Personal-first order. During the mixed
version window it also returns the same array as `teams`. New management routes
live under `/v1/organizations`; `/v1/teams` remains an organization-resource
alias for released flat-Team desktop clients.

Migration `0009_organization_team_hierarchy.sql` promotes every old flat Team
ID to an organization ID without changing it. Invitations, settings, billing,
GitHub installation ownership, audit records, and released desktop selections
therefore retain identity. Each promoted organization receives a new child
default-team ID.

The desktop keys `team:active-id` and `team:has-teams`, the engine's `teamId`
settings-context field, and legacy Team-named client exports remain serialized
or source-compatibility contracts. Their tenant-root values now represent
organization IDs. Rename or remove them only with an explicit migration and
mixed-version tests.

## Enabling multiple teams later

Before turning `teamCapabilities.multiple` or `canCreate` on:

1. define team creation, rename, deletion, and default-team replacement rules;
2. decide whether new organization members join only the default team or an
   explicit invitation-selected set;
3. add team-scoped repository/workspace authorization without weakening the
   organization boundary;
4. preserve the invariant that team membership is a subset of organization
   membership; and
5. ship API authorization, RLS, concurrency, migration, and UI race tests in
   the same change.

Do not reinterpret legacy `/v1/teams/:id` IDs as child-team IDs. A distinct
nested route is required for those resources.
