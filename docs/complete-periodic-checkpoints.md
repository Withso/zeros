# Dormant complete periodic checkpoint adapters

These components implement local journal, raw staging, periodic native export
and capture ordering for the opt-in complete checkpoint coordinator. The
production engine does not supply its complete option. There is no installed
cut helper, passing support record, Host transport or private-store adapter.
This is not an operational complete checkpoint producer or a final-stop path.

Local Personal and organization-local workspaces keep their existing behavior.
The new Linux adapters require an exact cloud organization/workspace,
generation, engine, writer and scope identity. An adapter cannot switch owners
or placements in place. The coordinator's existing serialized schemas are
unchanged and are shared through `cloud-complete-checkpoint-contract.ts`.

## Local scheduling custody

`openCompleteCheckpointJournal` explicitly creates or opens a private journal.
Open never initializes missing or corrupt custody. SQLite DELETE/EXTRA and a
short `BEGIN IMMEDIATE` transaction implement cross-process revision CAS;
original file and directory sync plus identity checks precede success. A lost
durability confirmation throws without erasing a possibly committed pending
attempt. Original attempts, deadlines and source counters cannot be replaced
or rolled backwards. Aliased or unsupported SQLite sidecars refuse access.

The Linux adapter also proves the independently opened SQLite reader. Before
accepting state, it requires exactly one new read/write FD with the retained
original's inode, mount and private metadata, then binds it to SQLite's native
RESERVED-byte lock through a bounded `BEGIN IMMEDIATE`/`ROLLBACK` probe. Linux
`fdinfo` associates that lock with its owning open file description. A cached
SQLite FD plus an unrelated new FD therefore cannot masquerade as the reader.
The probe changes no rows. Missing, reused, replaced or ambiguous descriptors,
unsupported lock evidence and another simultaneous native reservation refuse;
every probe exit rolls back and failed opening closes its owned references.
The retained original is an `O_PATH` reference on supported Linux x86-64/arm64;
its metadata, mount and descriptor flags are rechecked. Closing a separate
ordinary data FD would release the process's POSIX locks for that inode, even
when another SQLite connection still reports an active transaction. The adapter
therefore syncs the positively witnessed native SQLite FD and lets SQLite
manage its own data-FD lifetime. Both refusal and successful close preserve
peer read/write locks, as verified by kernel evidence and a separate SQLite
process. Initial creation derives its path-only reference through the held
no-follow creator and validates both descriptors before closing the creator.
It then links the canonical name without replacement; later cleanup owns only
the path reference, with no gap between original references.
The original and native descriptor identities are rechecked for subsequent
operations. A pathname, `database_list` or `/proc/self/fd` alias by
itself is insufficient. This driver/kernel boundary needs native runtime
qualification before enrollment; unsupported behavior has no permissive fallback.

The journal belongs to the workspace trust domain. It cannot prove root/Host
retirement or manufacture a private-store ACK. An unknown pending attempt
needs exact external reconciliation before another coordinator can be used.

## Raw cut and outside monitor

`complete_cut_custody.py` supplies an uninstalled Host-only syscall backend and
monitor. Missing support refuses before freeze. A future qualified Host must
hold the original admission lock and peer pidfd and prove all-writer placement
outside the monitor's own tree. The support and helper files remain open with
original inode/mount references, protected modes and fresh ACL/name checks.
The closed support profile includes files, state, HOME and repository backing
roots. Control, helper, lock and staging filesystems must be independent of
every source filesystem.

The monitor persists root pending custody before starting freeze, freezes the
original cgroup, then joins native ext4 FIFREEZE on every unique source
superblock. Cgroup frozen state alone is not completion of pending kernel IO.
After a cut, descriptor-relative no-follow/no-atime reads stage an immutable
full raw inventory. It includes private and ignored files, dependencies, empty
directories, supported sparse files, modes/times/xattrs/ACLs and contained
links. Unsupported metadata, external/missing links, foreign mounts or bounds
excess refuse the attempt. Bounds cannot truncate a successful inventory.

Every pending freeze job is joined before original filesystem thaw, followed
by cgroup resume. Persistent TERM/INT handling spans those operations and final
diagnostics. A deadline stops acceptance; it is not retirement evidence.
Unknown thaw keeps the monitor, original references and lock alive. Monitor
death leaves a durable marker that a successor cannot clear merely because
the flock is available. Recovery from monitor/kernel failure still needs the
separately qualified Host recovery boundary.

Raw staging can contain managed credentials and executable native databases.
It is private intermediate data and must never be uploaded or activated
directly. `materialize_raw_cut` is an isolated filesystem oracle: it does not
open a native engine, execute hooks, restore authority or create a storage ACK.

## Periodic native data

`exportPeriodicNative` consumes an independently verified immutable NORMAL/FULL
main/WAL or rollback-journal inventory. It recovers private disposable copies,
requires the exact native schema, and exports a separate inert JSONL kind with
cut positions, source, inventory hash, policy hash and exhaustive table counts.
It never obtains a final seal or opens the original writer.

Supported user rows, unfinished queued/dispatched input, replay/control data,
and accepted-work reservations remain in the export. Exact managed actor
grants, credential fences, session/claim bindings and seals are removed under
the versioned policy. Unknown tables/columns or mixed records refuse the
whole export. The current action store persists a request hash before dispatch
without its original payload; dispatching or uncertain actions therefore
refuse periodic export. Supporting those prefixes requires a durable payload
mapping before enrollment, not omission of the action.

`visitPeriodicNative` verifies every byte, exact inert row schema, unique row
identity and per-table coverage before completion. Consumers may not publish
rows while visiting. The bounded convenience reader and source-independent
SQLite oracle are test/recovery tools; the oracle only creates inert
`periodic_origin` and `periodic_data` tables, never runnable native queues.

Regenerate the exact repository-owned native layout with:

```sh
pnpm exec tsx scripts/cloud-workspace-validation/generate-complete-checkpoint-layout.ts
pnpm exec tsx scripts/cloud-workspace-validation/generate-complete-checkpoint-layout.ts --check
```

A changed profile requires review of the exhaustive row mapping. Regeneration
does not qualify a new schema or authorize deployment.

## Capture composition and remaining deployment gates

`createCompleteCheckpointCapture` requires explicit cut, complete-scope export
and private-store ports. It joins positive cut retirement before semantic
export, and export retirement before transfer. Each operation retains original
immutable references through final source/artifact verification. Unknown
retirement retries the same operation with a nonzero referenced wait; signals
or expiry cannot release custody. Successful results require the exact source,
original attempt/deadline and matching private receipt hashes. Durable age is
the data-cut age, not elapsed time since ACK.

The following work remains required before installing support or enabling the
coordinator:

- The real protected Host channel, full all-writer admission/final-stop join
  and independent recovery monitor, including real legacy AIO, mmap/writeback,
  signals, object replacement and original release on the qualified kernel/ext4.
- Exhaustive deployment-owned HOME/tool/state mapping and semantic handling of
  managed filesystem records. The raw copier is not this policy. Complete Git
  closure must include worktree/common-dir, submodule, LFS and object dependencies;
  a self-contained Git restore fixture does not prove arbitrary repository closure.
- Private encrypted object/manifest publication and exact remote ACK, complete
  lifetime retention, and qualified fresh-engine restore without expired provider
  snapshots or inherited execution authority.
- Measured writer pause, debounce, dirty-age, scan/staging/transfer and rate
  budgets. Fixture bounds and timings are not production budgets. Continuous
  edits must not starve saves; stale/failed saves report actual age to operators.

All controlled stops, Restart, Archive and candidate cleanup still require a
fresh complete final save before retirement once integrated. Periodic output
does not satisfy that final authority. No candidate-disposal shortcut,
retention/expiry/tiering restriction or user-facing notice is introduced.
The accepted durability model remains asynchronous complete saves plus provider
disk: combined abrupt VM and storage loss can lose changes since the last
complete data cut. No zero-loss claim follows from these adapters.
