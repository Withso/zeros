# Organization setup

The desktop Settings sidebar uses the same Local/organization selector as
navigation. Local keeps its existing device preferences, provider profiles,
secrets and repository settings. Organization settings are authenticated API
state. Switching accounts or organizations remounts forms and dialogs before
rendering their new owner; navigation preferences alone may be stored on the
device, keyed by account and organization and bounded to 64 owners.

Cloud repositories have distinct organization identities even when an identical
GitHub repository has a local checkout. Local navigation and creation never
receive cloud repository paths. Organization creation does not fall back to the
local engine. These are ownership rules; the existing conversation, terminal,
Files, Changes and Review surfaces remain the workbench for both placements.

## Agent connections

Agent setup is available before allocating a workspace. Claude supports multiple
setup-token accounts and API keys; Codex supports native device authorization
and API keys; Cursor supports its native browser authorization and API keys.
The organization UI offers Account and API, without the Local CLI connection.

Credentials belong to the signed-in human. Association with an organization
alone does not grant another member access. The selected account
and explicit model consent are stored by organization, human and provider.
Connecting authorizes that person's sessions on Zeros-managed compute until
disconnect or an authority/consent change. In legacy cloud, before a workspace session starts,
`POST /v1/cloud-workspaces/:workspace/agent-credentials/prepare` rechecks that
consent and creates bounded, exact-workspace self-delegations. It never grants
another member access or silently authorizes customer-managed compute.

Negotiated boot mode instead binds the workspace owner's selected accounts.
Prompter/Developer invitations or run-capable General access grants are consent
to shared funding: members' agents can use and read the owner's active provider
keys. Viewer access does not grant execution. The share dialog remains unchanged;
CP records the actual role/grant revision. Account changes apply on the next run
through background publication. See
[funding, cards and fenced removal](agent-authentication-and-language-tools.md#negotiated-boot-funding).

`GET /v1/organizations/:organization/agent-connections` returns metadata;
`PUT .../agent-connections/:provider` selects or disconnects with an expected
revision. `DELETE .../agent-connections/accounts/:credential` is the legacy
association-removal path. Active boot-funded sources require the durable
prepare/confirm/cancel removal flow; legacy writes cannot bypass its fence.
Credential material remains encrypted by the credential service.
An account edit, membership authority change, or revocation requires renewed
consent. Cursor account expiry is enforced by the backend.

Electron owns the `cloud_provider_auth` ceremony. Codex uses a dedicated private
profile and the pinned native runtime, then imports its native cache directly
into the authenticated credential service. It does not read a Local login's
profile. Cursor uses its SDK browser flow without a persistent local store.
Renderer messages contain only attempt identity, status, device verification
information, and resulting credential metadata. Attempts are window/account
bound, limited to five minutes and canceled when their dialog closes or becomes
inactive. Local subscription authentication remains a separate operation.

## GitHub repositories

One linked GitHub identity can connect its own personal account installation
and multiple organization installations. Simultaneous unrelated OAuth identities
are not represented by the existing GitHub credential store. An organization
installation is connectable only after GitHub confirms active membership for
the linked human. Outside collaborators and pending invitations do not satisfy
that requirement. The GitHub App needs organization **Members: read** permission
for this check, in addition to its existing repository permissions. Permission
changes must also be accepted on each installation.

The narrow `gh_cloud` IPC supplies the existing GitHub App user token in Electron
main. Renderer calls carry metadata only. The backend's `/v1/github/cloud`
endpoint verifies Zeros organization membership and the linked GitHub login
before using GitHub's user-token APIs. Repository pages reflect the intersection
of that human's access and the installation's repository selection; installation
tokens are never used to broaden the catalog. Archived, disabled and foreign-owner
repositories are excluded. Pages are bounded to 100 repositories and 100 pages.
Search filters the current page.

A source check records a two-minute proof for the exact human, organization,
installation and immutable GitHub repository ID. Account, membership and GitHub
authorization revisions fence the proof. Create admission rechecks it before and
after repository resolution. An already accepted idempotent create may replay
after expiry; a new create must refresh authority. Disconnect removes the
connection and its proofs. GitHub metadata and repository caches are bounded and
keyed by account, organization, installation and page.

Organization OAuth connection preserves the selected Local GitHub method.
Adding another installation opens the App's installation settings; returning and
refreshing discovers the new installation without replacing the isolated Dev
OAuth callback with the shared App's release callback.

Managed PR continuation uses the same branch/worktree operation as Local and
requires a current cloud actor with edit permission. Legacy trusted-device
relay permissions remain separate. A successful checkout of another branch
clears the old branch's PR binding atomically with the branch change. A failed
or unchanged checkout preserves it; explicit cancelled/backlog status is kept.

## Workspace sharing

Cloud workspace details expose sharing controls under current account/organization
admission (`useCloudWorkspaceAccountAccess`). There is no retired staff rollout
preference; workspace authority comes from the backend's current actor role. An
organization admin is a default **viewer** on an account-funded Pro workspace
until explicitly assigned another role. Organization-funded workspaces retain
their existing authority rules, including inherited manager/developer access.

Both the catalog and detail document add `actorRole` and
`capabilities.canEdit`. The existing `canWrite`, `canManage`, `canStart` and start
reason fields retain their behavior. `canWrite` includes agent submission;
edit services must check `canEdit === true`, rather than inferring edit authority
from staff status, organization role or `canWrite`. `canStart` remains a separate
lifecycle/funding decision; sharing does not grant wake, stop or delete authority.

| Workspace actor role | Read | Run agents (`canWrite`) | Edit (`canEdit`) | Manage sharing (`canManage`) |
| --- | --- | --- | --- | --- |
| Viewer | Yes | No | No | No |
| Prompter | Yes | Yes | No | No |
| Developer | Yes | Yes | Yes | No |
| Manager | Yes | Yes | Yes | Yes |
| Owner | Yes | Yes | Yes | Yes |

Role and sharing metadata remain optional in the renderer for mixed-version
servers. Missing edit authority disables edit controls. Missing role, sharing
mode or access revision disables sharing management. A null actor role can occur
on the owner's durable-data recovery path without granting compute or management.
No role is inferred from `ownerUserId` or organization membership.

Owners/managers use **Manage sharing** in the existing details popover. The
panel reuses the existing sharing, invitation, assignment and revocation APIs:

- Scope updates send the document's exact `accessRevision` as
  `expectedRevision`. A conflict refreshes metadata and requires a new explicit
  action; it never retries the write automatically.
- For preserved owner-only private workspaces, use **Enable collaboration**
  before inviting. This explicitly submits Private with the current CAS revision
  and keeps the scope private; reselecting Private alone does not enable sharing.
- Account-funded organization scope gives eligible unassigned members viewer
  access. Private scope retains the owner and explicit assignments/guest grants;
  it withdraws default organization discovery. Removing an assignment while
  organization-shared can leave that member with default viewer access.
- Invitations support viewer, prompter and developer. Assignment changes support
  only viewer/developer, matching the existing API. Prompter is an invitation
  role. Owner and manager rows have no role controls in this panel.
- The backend owns writer slots, Pro eligibility and reservations. The panel
  displays returned usage and blocks new writer selections when full. Viewer
  invitations remain available. Cancellation, downgrade, expiry and revocation
  retain the backend's existing slot-release behavior.
- Organization-funded lists return `writers: null`; their inherited assignments
  remain read-only in this panel. Existing invitations, guest removal and scope
  controls retain their backend authorization.

Collaborators are read as independent 50-row member, guest and invitation pages.
The bounded, memory-only cache includes account identity/generation, renderer
device/window scope, organization, workspace and catalog generation. It retains
same-key confirmations during refresh, revalidates the expanded page window,
rejects late pages after account changes, writes or replacement reads even when
sharing CAS is unchanged, and withdraws metadata on
denied authority. Display names are bounded page metadata; responses contain no
recipient email or invitation token. Pointer/focus intent warms read-only data.
Collapsed or inactive management views initiate no reads or polling.

### Alpha sharing acceptance runbook

This is an operator-run qualification on signed Zeros Alpha desktop on Mac.
Local PostgreSQL/browser fixtures do not qualify the combined runtime. Record
app/control-plane commits, runtime/base/template revisions and prerequisite
receipt IDs privately. Use only Alpha/test resources, with disposable names
prefixed `zeros-v2-test-`; never record credential values or invitation links.

1. Confirm integrated C5 template forks, B8 accepted-pin lifecycle behavior and
   B10 persistence qualification receipts for the fresh v4 base. Runtime edit
   checks also require the E1/E2/E3 consumers of `canEdit`; E4 owns shared-writer
   wake. Do not substitute older provider experiments or this PR's UI tests for
   those receipts. Enable Cloud Computer v2 in Internal settings for each staff
   account, and also verify the new sharing surface disappears with the flag off.
2. Use distinct owner, assigned developer, invited prompter and default viewer
   accounts/devices. Make the viewer an organization **admin** with no explicit
   workspace assignment. All accounts must meet the existing Alpha/Pro
   eligibility rules. Fork a disposable ordinary workspace from the sanitized
   Cloud Computer template through C5; record workspace/generation/template IDs.
   Confirm the chosen primary and secondary projections before testing access.
3. As owner, open details on pointer/focus intent and expand Manage sharing.
   Verify current scope, owner role, slot usage and participant names. Assign the
   developer through the member role control. Invite/accept the prompter using
   the ordinary signed-in invitation flow. Record invitation/grant IDs privately.
   A developer, prompter or viewer must see its actual role and no manager form.
4. Run the read-only API companion below for all four accounts. Verify the admin
   viewer reports `canWrite: false`, `canEdit: false`, `canManage: false`, and
   that its collaborator-list read is denied. Verify the prompter can run but
   cannot edit; developer can edit but cannot manage sharing/credentials. Owner
   can manage. Do not change expected results to accommodate a failed check.
5. Across devices, read shared primary Files, Git comparisons, saved chat and
   terminal inventory. Submit an agent prompt as developer and prompter; the
   viewer cannot submit or execute. Try direct file/Git mutations, terminal
   creation/input, SSH and edit services as viewer/prompter: controls must be
   unavailable and server admission must deny attempts. Repeat as developer to
   establish allowed behavior. Secondary repositories are writable under ACD-3,
   but Alpha Files and checkpoint coverage remain primary-only.
6. On two owner devices, keep the same sharing revision open. Change one to
   Private, then submit the stale scope change on the other. The stale action
   must conflict, refresh to the accepted scope and require an explicit new
   action. The default admin viewer loses workspace discovery/read access;
   explicit developer/prompter access remains. Re-run the API companion with
   the viewer case's `expectedStatus: 404`. Restore organization sharing and
   verify the viewer regains only viewer authority.
7. Exercise the final available writer slot with two owner devices. At most one
   competing writer assignment/invitation succeeds. Confirm the refreshed count
   never exceeds the returned limit, and viewer invitations still work. Cancel
   a pending writer invitation and downgrade an assigned developer to viewer;
   confirm capacity returns and new edits/services from the downgraded device
   are denied. Re-run the companion with the new expected role. Existing service
   withdrawal must satisfy the runtime admission owners' acceptance checks.
8. Revoke an accepted guest and verify its live connection/access is withdrawn,
   its workspace read becomes unavailable, and its slot is released. Removing an
   organization member's assignment while shared must leave only default viewer
   authority; under Private it must remove access. Re-run the companion for each
   state. Expiry and failed-delivery cases use existing invitation policy, never
   an altered database clock or relaxed eligibility.
9. Switch accounts while a collaborator read/page is delayed and verify no
   participant/form state crosses owners. Reopen the same authorized workspace
   to confirm cached rows survive a refresh failure. Close/collapse the view or
   navigate away: no hidden collaborator reads, focus or polling may continue.
   Where the test organization supplies more than 50 members, load More members
   and refresh after a removal; rows must not duplicate or resurrect. Record
   unavailable live pagination coverage explicitly; synthetic pagination is
   covered by the browser/cache suites.
10. Cancel all test invitations, revoke test guest grants/assignments, close
    terminals and retire SSH/preview grants through their owning controls.
    Restore any pre-existing scope/roles, then delete disposable workspaces as
    their owner and confirm physical cleanup through the existing lifecycle.
    Record resource IDs and completed cleanup privately, including any residual
    item that blocks acceptance. Do not revoke shared credentials or remove
    pre-existing organization membership.

The API companion reads credentials only from the orchestrator's `.env.agent`
and contacts the repository's Alpha API origin. It issues GET requests only,
creates no resource, and prints only closed check codes, roles, revisions, page
counts and writer availability. It does not prove Mac/device/runtime behavior.
Place current per-account Alpha access tokens under these variable **names** in
that private file: `ZEROS_E5_ALPHA_OWNER_ACCESS_TOKEN`,
`ZEROS_E5_ALPHA_DEVELOPER_ACCESS_TOKEN`, `ZEROS_E5_ALPHA_PROMPTER_ACCESS_TOKEN`, and
`ZEROS_E5_ALPHA_VIEWER_ACCESS_TOKEN`. Never pass token values on the command line.

Create gitignored `.context/e5-sharing-cases.json`. Start with this synthetic
example, replace all IDs with the recorded Alpha IDs, and add developer,
prompter and viewer cases using their own token variable and immutable account
ID. Set the viewer's `organizationRole` to `admin`; other cases need not assert
an organization role. Use the current role/scope at each checkpoint above.

```json
[
  {
    "name": "owner",
    "tokenEnv": "ZEROS_E5_ALPHA_OWNER_ACCESS_TOKEN",
    "actorUserId": "33333333-3333-4333-8333-333333333333",
    "organizationId": "11111111-1111-4111-8111-111111111111",
    "workspaceId": "22222222-2222-4222-8222-222222222222",
    "expectedStatus": 200,
    "actorRole": "owner",
    "sharingMode": "organization"
  }
]
```

```sh
node scripts/cloud-workspace-validation/verify-sharing-controls.mjs .context/e5-sharing-cases.json > .context/e5-alpha-sharing-receipt.json
```

Exit 0 means the supplied cases passed their API checks. A denied private/revoked
case expects 404 for both detail and collaborators; an accessible nonmanager
expects 403 for collaborators. An owner data-recovery case with `actorRole: null`
expects all three projected capabilities false and collaborator access 404.
A scope/revision change during pagination fails
the read and requires rerunning the read after the state settles. Keep these
receipts alongside the manual checklist; do not label live acceptance complete
until all required Mac/runtime observations and cleanup are confirmed.

## Cloud Computer

With the internal Alpha Cloud Computer v2 feature enabled, engineering staff who
are organization owners or admins can choose **Configure with an agent** after
a successful active build. The active configuration must include at least one
repository. The server reuses that creator’s private admin workspace for the
current active version, or creates one for a newly activated version. Each open
starts a new conversation and publishes its workspace destination atomically.
Older admin workspaces stay in the normal workspace list with an **Admin** badge
derived from server metadata. See [Computer agent tools](computer-tools.md).

Cloud Computer is an organization-owned, versioned setup configuration. It
stores up to 20 immutable repository identities, an install script of at most
16 KiB, and a setup-command timeout of at most 900 seconds. Owners and admins
can save, build, activate or cancel; members can read the shared configuration.
Saving uses revision comparison and a stable operation ID. Repository access
proofs belong to the saving administrator, not to a different member who first
selected the repository.

A build is an ordinary, explicitly disposable managed Boat workspace. It uses
the same admission, quotas, compute sponsorship, qualified base image and setup
isolation as a coding workspace. The build pins an immutable configuration
version and one selected test repository. It is private, excluded from normal
workspace discovery, and cannot fork Local data or select a customer provider.
It is a setup validation run, **not a cached VM snapshot**: new workspaces run
the active install script again. Other selected repositories are not implicitly
claimed as tested by a successful run on one repository.

Build completion records readiness or a bounded failure. The backend queues
receipt-verified deletion through the existing lifecycle reconciler, including
canceled and timed-out builds, without requiring an open desktop. The build
record distinguishes a requested cleanup from completed physical deletion.
The deadline is 30 minutes from admission. Arbitrary setup output remains subject
to the existing withholding policy; the UI does not expose an unrestricted
build-log stream.

A successful build is evidence, not activation authority. An administrator must
explicitly activate a successful version using the current revision. Drafts and
failed builds never replace the default. Activation affects newly created
workspaces for the selected repository IDs only; existing workspaces keep their
pinned settings. The Cloud Computer script runs before repository setup commands,
with managed policy applied last. Unselected repositories retain their normal
settings. Generic environment-profile edits cannot modify/delete this managed
profile.

Migration 0106 stores private agent associations and consent, 0107 stores GitHub
connections and short-lived proofs, and 0108 stores immutable computer references
and build history. These tables use system-only RLS; endpoint authorization is
rechecked in every transaction. Provider deletions and encrypted secrets retain
their established services and contracts.

## Qualification

Automated browser tests use actual settings components with synthetic transport
and no workspace or Local CLI. PostgreSQL tests exercise authority changes,
source proofs, immutable versions, setup ordering, build admission and cleanup.
Native authentication, real GitHub permissions, provider execution, and Boat
lifecycle still require live qualification of the deployed source and image.
A passing local database or browser fixture is not proof of hosted parity.

Boat may expose its command channel before snapshot restoration has finished
replacing runtime files. An image-contract failure stays a failed admission,
but the setup worker can retry the complete helper within its existing bounded
claim budget (five claims by default). Each claim gets fresh, fenced setup
authority and must pass every integrity and readiness check. Persistent
mismatches exhaust the budget and fail or roll back; retries never reuse a prior
proof or relax an integrity gate. Other providers retain their existing policy.

## GitHub writes from the existing workspace controls

Cloud Push, Create PR, Edit PR, Ready for review, Merge and Review comments use
an actor-bound write admission. Electron supplies the selected GitHub App user
credential directly to the backend. The renderer receives a one-use, two-minute
admission bound to the organization, workspace generation, operation and request
digest. The current engine exchanges it for a three-minute proxy capability;
it never receives the GitHub user credential.

The backend checks current workspace edit access, the connected GitHub account,
installation membership and repository write access. Each proxy request rechecks
the engine, actor session and GitHub connection, and confirms GitHub's immutable
repository ID. GitHub receives the **user access token**, so the user's permissions
and branch rules also apply. An installation token must not substitute for the
human's identity, even if an earlier permissions probe succeeds. See GitHub's
[on-behalf-of-user guidance](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app).

The proxy permits one exact PR mutation and/or one receive-pack request for the
workspace branch. It rejects branch deletion, other refs, other PRs, additional
request fields and general GraphQL. An uncertain write result is not retried.
The existing draft-unsupported fallback is permitted once after GitHub explicitly
rejects the draft with 422. User tokens are temporarily sealed using a key derived
from the opaque capability; release or expiry deletes the ciphertext. Cleanup
does not revoke the user's GitHub connection. Local Git/PR requests retain their
normal credential path. Native shell/agent `gh` writes are a separate admission;
these controls do not turn the ambient repository read token into a write token.

Managed Git runs as the workspace UID. Disposable indexes, merge inputs, archive
patches and include-pattern files must therefore belong to that same UID, even
when the engine creates them under its private umask. The temporary-file helper
uses exclusive creation and descriptor-based ownership changes. Cloud index
copies reject links and non-workspace owners; engine credentials and policy
directories are never part of this projection. Local Git keeps same-user,
owner-only temporary storage.

Cloud commit authors default to the member's connected GitHub profile: the
display name (or login if no usable display name exists) and the private
`ID+LOGIN@users.noreply.github.com` address. Zeros reads the immutable account ID
from GitHub's authenticated `/user` response and never uses its public email or
the member's Zeros sign-in email. GitHub documents the
[private address formats](https://docs.github.com/en/account-and-profile/reference/email-addresses-reference);
older accounts using username-only private addresses may need to enable the
ID-based format in their GitHub email settings for commit attribution.

Migration 0112 stores this metadata on the existing authorization. Sign-in and
normal installation/catalog refreshes populate older connections. A different
immutable GitHub ID cannot replace the account through a metadata refresh.
Managed authoring resolves the live workspace actor; agent admissions resolve
the member submitting the turn, including when they use a shared provider
connection. The private admission response includes the author only when the
engine requests `includeGitAuthor`, preserving old worker compatibility.

Git author/committer defaults belong to the individual operation or provider
process, never the shared repository/global config. Amend and replay retain
Git's original-author semantics. Native and retained legacy tool-bridge
conversations receive the same defaults. New cloud terminals use their launching
member's identity; reattaching an existing terminal retains that shell's starting
identity. A missing GitHub connection does not borrow another member's identity;
managed commits request connection/refresh and native Git has no default author.
Local identity handling is unchanged. Custom per-member author settings remain a
future addition.

## Automatic stop after inactivity

An admitted cloud engine observes ten minutes without work before requesting
an automatic stop. Running/queued agents, pending permissions or questions,
setup/run jobs, open live terminals, SSH/port services and user/background
processes prevent it. Merely closing the desktop does not cancel accepted work.
Read-only polling, saved-chat reads and heartbeats do not count as user activity.
An open terminal intentionally keeps its environment alive until that terminal
is closed or exits.

The engine reserves process admission, pauses restartable language servers and
rechecks user processes before requesting its final checkpoint. New work cancels
that reservation. The backend independently checks queued commands, execution
leases, runtime-service grants, GitHub writes and Cloud Computer builds. It
checks again when accepting the final checkpoint. Only a completed checkpoint
allows the ordinary lifecycle reconciler to stop the VM. Inspection, authority
or checkpoint failures leave the workspace running; there is no force-stop
fallback. A restarted engine observes a new interval. This is distinct from
compute-credit limits, provider TTL and heartbeat safety stops.

Idle observations log only bounded activity counts and quiet duration, at most
once per minute. They contain no commands, paths, prompts or credentials.
Live qualification is tracked separately from the unit/integration coverage;
an unconfirmed stop must not be reported as a successful automatic shutdown.

Cloud Computer validation still runs the recipe on a disposable workspace.
It does not yet publish a reusable baked image. A future baker must use a clean
builder, sanitize private state and qualify the exact artifact before activation;
a snapshot of an ordinary organization workspace is not a safe template.
