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
