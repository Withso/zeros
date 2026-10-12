# Durable Computer snapshots

A completed Computer is published only after its sanitized, stopped builder has
been saved as a Boat named snapshot. The control plane records the exact name,
source sandbox, snapshot ID, size and complete saved-tree proof before marking
the template ready. The tree must be available and untruncated, contain the
Computer manifest, and have empty private roots matching Computer sanitation,
including native `.zeros-persist/home` and `.zeros-persist/state` backing roots.
Repository content under `.zeros-persist/files/repos` remains allowed.
Unsafe paths, aliases, credential-bearing files or a changed snapshot identity
refuse publication. The proof hashes metadata; it does not download private
file contents. Existing runtime, protected-contract and manifest checks still
run in the builder. Live provider qualification remains a rollout requirement.

Qualify the saved-tree proof against a real Boat `GET /snapshots/<id>/tree`
response before relying on publication or migration. Boat uses `dir`, `file`
and `symlink` entries; only files carry `size`, and additional top-level metadata
is allowed. Paths use POSIX `/` separators: literal backslashes in systemd unit
names are ordinary filename characters, not escapes to decode. Symlink ancestors
still refuse proof, including aliases of private roots with no listed children.
Keep qualification evidence private and record only aggregate metadata and the
proof receipt, never file paths or contents. Synthetic fixtures cover the wire
shape but do not replace this live qualification.

The name is `<org-slug>-<channel>-computer-v<N>`. Channel is `development`,
`alpha`, `beta` or `production`. Slugs are normalized to lowercase ASCII and
hyphens and shortened to keep the whole name within Boat's 63-character limit;
an empty normalized slug becomes `org`. N is a positive bigint allocation
counter for the channel, independent of the organization's build version.
The counter spans all organizations, wallets and account scopes in that
database. This keeps names distinct after slug reuse, normalization, shortening,
renaming or organization deletion. Failed/rolled-back attempts leave gaps.
Counters never cycle or reset. Persisted names never change.

Boat's named namespace and ten-free allowance are account-wide. Exactly one
database/controller must own each physical account/channel allocator. Preserve
the sequences when restoring or moving databases; reconcile retained rows and
complete provider inventory before enabling an allocator in a replacement
database. A pre-existing provider name is an ownership conflict, never something
to overwrite or adopt. Separate Dev databases must not claim the same channel
namespace. A wallet change does not create another namespace.

New allocations use a `boat-computer:<name>@sha256:<manifest>` pin and
`POST /sandboxes {from: name}`. They do not inspect the expired builder sandbox.
The accepted generation, org, channel, account and wallet authorize that exact
artifact. Legacy `boat-template:<sandbox>` generations continue their original
fork request. Migration changes subsequent template selection; it never rewrites
accepted workspace generations, create digests or idempotency keys.

Keep the active and one previous named template per organization, plus every
template referenced by a workspace whose workspace/data deletion is unfinished.
That includes stopped workspaces, retired generations, bound allocations and
legacy fork pins. A workspace source hold ends only when its status is `deleted`
and `data_deleted_at` is set; a delete request alone does not release it. There
is no additional ready-history hold.

An in-flight build or accepted, unbound workspace create also holds its exact
name. Deadlines, cancellation, generation retirement and even workspace data
deletion do not close an unknown dispatched create. It must be allocated or
positively closed before that separate hold ends. Extra names during these
holds or unconfirmed deletion are visible retained costs, not grounds to force
deletion. Activate refuses a retired named artifact and directs Rebuild.

Named retirement is distinct from the [stopped-template policy](computer-template-retention.md).
Both have zero ready-history and retain unfinished workspace/data source
references. Named retirement also preserves unresolved allocation holds.
Organization erasure waits for both stopped-resource and named-artifact
cleanup. Named deletion requires the exact channel, source and snapshot identity;
foreign channels, base names, runtime names and legacy worker names are refused.
Neither policy extends Boat's automatic stopped-sandbox clock.

Each save has a committed, single-dispatch latch. Lost replies are reconciled by
that exact name, never by another save. Unknown saves with no observed artifact
stay unresolved even on 404; they may have been accepted asynchronously. Cleanup
must not erase that evidence or reuse the name. Publication also rechecks the
worker fence, cancellation and deadline after provider proof. The Alpha Computer
worker reconciles named retention every minute under the existing background
worker switch. Keep that worker and its artifact configuration available through
migration/retirement; a paused worker cannot perform cleanup.

## One-time operator

`pnpm --dir apps/control-plane exec tsx src/manage-cloud-computer-snapshots.ts` plans by default.
It requires a direct PostgreSQL migration-owner connection, an active
organization owner/admin, the exact organization slug, and ready active/previous
templates with their archived builder journals. Personal owners are refused.
Production is refused, including a mismatched Railway environment. Planning
does not construct a provider, write an audit or consume sequence numbers.
Unallocated names are displayed as a prefix with `<N allocated on execute>`;
the approved plan binds the naming rule and exact sources, not a guessed number.

Use the normal securely supplied `DATABASE_URL`, `BOAT_ACCOUNT_SCOPE`,
`BOAT_BILLING_ORG` and, only for execution, `BOAT_API_KEY`. Do not put secrets in
arguments or copy provider responses into a report. Supply these additional
environment variables with prefix `CONTROL_PLANE_COMPUTER_SNAPSHOT_MIGRATION_`:

- `CHANNEL`: `development`, `alpha` or `beta`, matching the target deployment.
- `ORGANIZATION_ID`, `EXPECTED_ORGANIZATION_SLUG`, `ACTOR_USER_ID`: exact owner identity.
- `APPROVAL_ID`: a fresh UUID for this reviewed run.
- `REASON`: 16–512 characters describing the approved migration.
- `APPROVAL`: the plan's target-bound approval, required with `--execute`.

Master reviews the dry-run and obtains owner approval before running `--execute`.
The approval binds the database fingerprint, channel/account/wallet, actor,
reason, head revision and exact template/version/source/manifest tuple. A changed
head or source requires a fresh plan. Execution audits the request before provider
I/O, saves/proves each source, and switches subsequent selection only after proof.
Per-artifact ready/retired audits retain identity and the proof hash. Repeating the
same approved command resumes partial progress without replacing a saved name;
a completed replay dispatches nothing. Provider/driver errors are redacted.
This operator does not rebuild expired sources: those require Rebuild.

Deploy the additive schema and compatible readers before enabling the new
producer. Quiesce older Computer producers so their claims cannot publish
unprotected stopped-only templates. Keep the compatible binary and schema on
rollback; disabling production must not disable cleanup of pending saves.
Before the retention deadline, qualify a disposable Alpha build, its named saved
tree, name-based allocation, migration replay and retirement using private
evidence. Provider statements alone are not evidence of those deployed paths.

## Account count and placement

Let B be all retained base, legacy-worker and other non-runtime/non-Computer
names across the shared account, and R its distinct retained runtime-image
names. For each organization/channel pair, count the distinct named Computers
in the union of active, previous and unfinished workspace source references.
Let C be the sum of those counts, and U the additional distinct Computer names
held only by in-flight builds, unknown creates or deferred cleanup. The expected
account-wide count is **B + R + C + U**. Without older source references, C is
at most two per organization/channel pair; references can make it larger.

Monthly named storage is **$1.70 × max(0, count − 10)**. The ten free names are
shared by Dev, Alpha, Beta and Production. A count of 9 costs $0, 11 costs $1.70,
and 13 costs $5.10 per month. These are examples, not a live inventory. Record a
read-only account-wide inventory at rollout, deduplicating names and preserving
foreign-channel names. No fixed live count is asserted by this source change.

Local Personal and organization-local workspaces keep their Host lifecycle.
The changes apply at the organization-cloud control-plane boundary. Source pins
remain keyed by exact owner and generation across owner or placement switching.
