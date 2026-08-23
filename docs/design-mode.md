# Design mode — one workspace, separate authority

**Status:** Public desktop feature, enabled by default. Current engineering and
product contract (2026-08-23).

A Zeros workspace has one semantic identity and one full checkout. `viewMode`
only selects the visible Code or Design surface; it never grants filesystem
authority. Agents, terminals, dev servers, and installs may keep running while
the user views Design, so switching views is local and immediate.

The persisted `workspaces.view_mode` column is the canonical presentation
field. `kind` remains a synchronized compatibility mirror for older call sites
and serialized clients; neither field authorizes an actor. A code agent's role
and immutable write territory are established independently when its runtime is
created.

The renderer publishes a user's Code/Design request as exact-workspace local
presentation state in the click frame. It does not overwrite the last confirmed
workspace-list snapshot. Once `workspace.setMode` succeeds, its authoritative
field result is patched onto the newest exact-key row before the local request
is removed; failure removes the request and returns to the retained confirmed
surface. This prevents both the old RPC-latency pause and a one-frame bounce
while background list revalidation completes.

The successful transition receipt also carries the first aggregate Design
snapshot. The renderer publishes that snapshot before revealing the Design
surface, so entering Design does not repeat the initialization parse/lint pass.
Subsequent reads use a bounded, exact-workspace stale-while-revalidate cache and
share concurrent engine scans. The last four confirmed lightweight snapshots
are mirrored under the versioned settings key
`zeros-design-workspace-snapshots-v1` (750,000 characters per workspace and
2,000,000 total) to make renderer reloads paint synchronously. Hydration strips
embedded asset bytes and the engine-process protocol capability, validates the
stored checkout path, and always revalidates against the new engine generation.
Permanent deletion prunes the durable entry; archive retains it for restore.

The shell retains at most two recently used Design workspace surfaces. MRU
order chooses eviction only: surviving iframe-owning DOM siblings keep a stable
physical order so Code/Design and Design/Design round trips do not reload their
browsing contexts. Hidden surfaces remain inert and suspend active-only work.

## Current actor contract

| Actor                                | Code / repository roots                                                                                   | Recognized Design directories                                               | Other host state                                                                        |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Human Design surface                 | Read context; no code-write operation is exposed                                                          | Mutates through the trusted in-process Design Document API                  | Trusted app authority                                                                   |
| Zeros-launched local code agent      | Current and explicitly attached roots read/write; unrelated Zeros-managed workspace collections read-only | Read-only, for every recognized root; contents remain readable and listable | Normal host-parity access                                                               |
| Zeros file/Git commands              | Read/write subject to command semantics                                                                   | Engine-owned Design mutations remain serialized                             | Trusted engine authority                                                                |
| User terminal or external editor/Git | Full same-user OS authority                                                                               | Read/write                                                                  | Outside the Zeros agent boundary                                                        |
| Design-agent boundary substrate      | Managed workspace collections and registered repository roots read-only; minimal canonical Git metadata remains writable | Read/write for every recognized root                              | Normal host-parity access outside admitted repository roots; no production consumer yet |

Reads are intentionally broad: code agents may inspect Design and designers may
inspect code. Write authority is asymmetric and does not follow the selected UI
surface.

## Code-agent containment promise

For a workspace with recognized Design territory, Zeros starts a local code
agent only when all of these conditions hold:

1. The canonical workspace root and active `[design] directory` are resolved at
   each new-session or resume admission.
2. The active directory and every other committed Design document in the
   checkout are real, symlink-free directory paths. The actual trees are walked,
   so ignored and untracked drafts and nested directories are covered. A
   pre-existing Design file with more than one hard link refuses admission.
3. The local immutable profile preserves host write authority, then makes each
   stable Zeros-managed workspace collection read-only. It reopens only the
   current workspace and managed islands covered by an explicit `/add-dir`
   grant, then carves every recognized Design root and generation-private ZSR
   descriptor inside those islands back to read-only. Canonical Git metadata
   stays ordinary and writable.
4. Physical main checkouts, open project roots, and other registered owners
   outside managed collections still contribute exact Design denies.
   Registering a root never grants write access to that root. Cloud-only and
   stale missing paths contribute no local authority. Multiple Design roots
   are first-class; none is selected merely by the current canvas or cwd. Thus
   an agent running in workspace A cannot write a managed sibling at all unless
   it was explicitly attached, and cannot write a recognized Design document
   in an attached sibling or external registered owner.
5. The engine installs the exact profile with Seatbelt on macOS or a
   mount-only bubblewrap profile on Linux before any provider byte starts.
   There is no instruction-only fallback.
6. The process tree is observable and must be terminated completely before a
   changed territory can be published.

Claude, Codex, Cursor, custom/PATH tools, ordinary MCP children, shells, hooks,
and subprocesses inherit this one external OS boundary. Provider-native
permission modes still control approval UX, but they neither establish nor
weaken the Design filesystem fence. Codex Browser fails closed on contained
macOS threads because its helper requires a conflicting nested Seatbelt profile;
Zeros does not move user-writable plugin code outside the boundary. ZSR does not
otherwise replace HOME, XDG roots, Keychain, GH/GitHub tokens, SSH agent, Git
configuration, network, ports, logs, or ordinary tool paths in the local
profile. Engine bearer/control variables and ambient Docker/Podman selectors are
stripped; only a private container worker may add the latter back. Known and
advertised ambient container Unix sockets are subtracted as well. On macOS,
Apple Events and Launch Services app opening are denied so `open`/`osascript`
cannot launch an unrestricted process outside the inherited fence. Reads of
Zeros app data otherwise retain host parity, while writes to the small authority
set that defines the fence are denied: the workspace/project database and
SQLite sidecars, worktree recovery seeds, sticky Design recognition, and the
current generation's private control descriptors. Without that carve-out an
agent could change the next admission's Design-root union without touching a
Design file.

The code-agent runtime receives no Design API or Design MCP tool. Engine bearer
credentials are not written into its workspace or environment. The territory
instruction is still injected on the provider's native system/developer channel
as defense in depth, but prose is not the boundary.

This is a scoped security guarantee, not a claim against kernel compromise,
root/administrator access, or a trusted human using a separate terminal. It
applies to direct filesystem operations by the Zeros-launched agent process tree
on a qualified OS. An already-running unsandboxed same-user service acts with
its own authority when asked to perform work; known container workflows are
therefore routed to an actor-scoped private worker rather than an ambient daemon.
Future automation/deputy integrations must preserve the same actor policy. If
the profile, tree validation, exact canary, or process teardown cannot be
proved, the agent does not start or the authority transition does not complete.

### When a Design territory begins

A folder name alone is not semantic Design identity. A document becomes
recognized by a committed `.zeros-canvas.json` marker or by Zeros' controlled
first Design initialization. Repositories with neither a recognized document
nor an existing configured/default destination preserve ordinary code-agent
behavior.

There is one conservative bootstrap exception to semantic recognition: when
the configured/default `Zeros Design/` destination already exists, code-agent
admission protects that real subtree as prospective territory even if its
marker is still untracked or absent. This closes the checkout-hook/manual-seed
gap without treating its content as an editable Design document. Arbitrary
non-default folder names are not adopted by name alone.

On first initialization—including an untracked default folder seeded by a
checkout hook—Zeros blocks new starts and retires sessions admitted before the
territory existed, then initializes, commits, and publishes it. Pointer
changes and Git operations that add, remove, or replace recognized Design roots
use the same retire-before-publish rule. A non-default folder manually created
outside Zeros remains ordinary user filesystem state until a committed marker
and controlled pointer transition establish its identity.

That containment handoff is an admission queue, not a user-facing failure.
Mode/lifecycle requests and new or resumed agent sessions arriving after the
gate closes wait for the complete queued owner transition, then revalidate the
workspace. If an owner transition crosses a native agent bind that was already
admitted, the incomplete execution is disposed and the bind is retried against
the new authority. The transient gate message must never surface as a Codex,
Claude, or Cursor provider error.

Creating a managed sibling—including creation from an existing branch—for an
already registered main repository is not an authority handoff for existing
actors: the stable parent collection was already read-only before the sibling
path existed. Zeros publishes and fences the new owner without cancelling
unrelated sessions, Setup/Run tasks, or pooled provider utilities. Those actors
retain per-owner snapshots for every reopened island, so a real pointer or
recognition change in an island they can write still uses
retire-before-publish. Registering an external owner outside the stable managed
collections remains a global handoff.

## Shared-checkout scope

The isolation guarantee applies to a **Zeros-launched code agent** and to
Zeros-owned file/Git mutation routes. An external editor or coding platform
opened on the same checkout remains ordinary same-user software and may edit
the Design directory.

Zeros does not install persistent filesystem ACLs for normal operation. Such an
ACL would attach policy to shared files instead of to the actor and would block
unrelated editors, Git clients, and coding platforms. Builds that previously
installed macOS ACLs remove their exact historical entries once at startup;
that compatibility cleanup is not part of agent admission and cannot roll back
a workspace create.

The provider sandbox still resolves the actual filesystem on every admission:
the active and recognized Design roots, ignored and untracked contents, nested
directories, symlinks, hard-link hazards, and Git metadata all inform the
immutable actor profile. This is actor-scoped on macOS and Linux/Daytona and
therefore does not change what a separate application can do.

## Git and lifecycle coordination

Local code agents use the canonical repository. Read-only commands, commits,
hooks, signing, fetch, push, clean, rm, mv, restore, stash, and every operation
that can name a path run as ordinary Git inside the actor's OS fence. There is
no shadow repository, private index, remote broker, hook suppression, or stderr
rewriting. Consequently `git checkout <commit> -- <designfile>` and equivalent
pathspec forms cannot write Design content.

Whole-tree checkout/switch/pull/merge/rebase/cherry-pick/revert and hard reset
are different: a compiled dispatcher forwards them to a generation-scoped
engine broker, which re-parses the complete argv, bounds the canonical cwd to a
registered owner, and runs hardened engine Git outside the code fence. This
preserves the pre-ZSR expectation that changing branches or integrating a
branch can materialize tracked Design changes. Checkout/reset path forms are
returned to native Git and remain fenced. Stash stays native because it is
agent-authored state, not a trusted repository integration. Because Git accepts
a one-argument checkout as either a ref or a path, the broker grants it only
after that argument resolves to a commit in the exact registered worktree and
metadata identity. The authorized invocation is then pinned to a full local
branch ref or immutable detached commit, preventing a disappearing ref from
being reinterpreted as a path; otherwise it falls back to native fenced Git. A
naked `checkout HEAD` or `checkout @` also stays native because pinning that
no-op to its commit would incorrectly detach a symbolic branch. A
nested unregistered repository cannot borrow its parent's integration
authority.

This split consciously accepts one residual: an agent that can construct and
commit a Design-changing tree without directly writing the Design worktree can
then ask a tree-level merge to materialize it. Closing that commit-then-merge
route would require content-aware authorization or a different Design/Git
product contract; it is not represented as stronger isolation here.

The design-agent substrate is the app-wide inverse. Every registered repository
owner is read-only, all recognized Design roots are writable, and the smallest
canonical Git metadata directories for the current owner are reopened writable.
Directory islands are required:
binding an existing index file individually prevents Git's atomic replacement.
This lets native Git stage Design changes without reopening code files.
Read-only Git succeeds. Staging, committing, fetching, and pushing can succeed
through the metadata islands when their hooks and worktree effects do not write
code. Checkout, pull, reset, merge, or a hook that needs to update a forbidden
code path fails at that write boundary. Trusted Zeros Git routes may perform a
broader operation only inside the serialized Design mutation lane below; they
do not lend that authority to the agent process.

Zeros-run checkout, pull, rebase, merge, reset, stash, and turn-restore paths
share the Design mutation lane. They retire an obsolete authority map when
needed, perform the Git operation, and resolve the resulting real tree before
process admission reopens. The filesystem/Git watchers reconcile external
HEAD/ref/index, exact canvas-marker, and settings movement and retire sessions
whose captured semantic territory no longer matches.

Mode changes themselves do not restart an agent when the territory is
unchanged. Archive, restore, delete, first Design creation, Design-directory
settings changes, and territory-changing Git rewrites use fail-closed process
drain and lifecycle sequencing. Because every code boundary contains the
app-wide registered-owner union, adding, removing, archiving, restoring, or
unhiding a project/workspace blocks all new repository-code admissions, cancels
pending starts, proves every Setup/Run boundary stopped, and retires every
code-agent and pooled utility boundary before publishing the new owner set.
Overlapping changes remain queued behind one continuously closed admission
gate. Chats resume under a newly admitted profile on their next use; stale
immutable profiles are never patched in place.

External Git-ref/index changes, metadata-signature changes to settings files,
and exact `.zeros-canvas.json` create/change/remove events enter the same
reconciliation path. The watcher previews the semantic territory first, so
ordinary source saves and ref updates that do not change Design ownership do
not restart agents. A changed or invalid owner drains the old app-wide
authority before the new territory is recorded and fenced. External tools still
run outside Zeros' actor boundary, so their multi-file rewrites and the watcher
transition are not one atomic operation.

## Design API terminology

Two APIs must not be conflated:

- The **Design Document API** is today's trusted in-process semantic transaction
  kernel used by the human canvas. Its package default fails closed if an
  external caller omits authorization, while the desktop explicitly marks its
  internal human path trusted.
- A future **Design Orchestration API** may let a code conversation request
  `design.explore`, query status, cancel work, and receive artifact references.
  It will spawn a separately authorized design actor; it will not give the code
  agent code-tree write authority.

The inverse raw-filesystem boundary exists and is live-tested, but no design
agent or code-to-design orchestration endpoint is wired today. Product wiring
must select the `design-agent` actor explicitly; changing the visible Design tab
never changes an existing code agent's authority.

## Verification and performance

The named containment gate exercises real Codex and Claude sandbox attacks on
Linux and macOS, provider-profile invariance across approval postures, Claude's
pinned built-in Write/Edit rules against a local deterministic model endpoint,
complete provider process-tree teardown, real-tree discovery, hard-link refusal,
first-creation/settings/Git lifecycle transitions, and the absence of a
coding-agent Design API path. Its attack matrix includes overwrite, append,
truncation, nested and ignored creation, atomic replacement, rename, symlink,
hard-link, policy, Git-metadata, generic Git attempts, and fail-closed pathname
encoding. Admission tests additionally cover workspace/cwd aliases, launch-path
overrides, additional working roots, and managed-policy escape hatches. A
separate regression proves the shared checkout remains writable outside Zeros.

Tree enumeration is not placed on the editor, canvas gesture, render, or source
save hot paths. It runs at admission and at serialized Design/Git/lifecycle
boundaries, so normal coding and canvas interactions retain their existing
latency characteristics.

## Compatibility

- Pre-mode separate Design worktrees remain readable; legacy sparse cones and
  whole-tree ACLs are removed during boot/exit migration.
- Design mode and Design workspace creation are available to every desktop
  user without an Internal flag. Design-surface operations remain desktop-only,
  and Design rows remain excluded from relay workspace lists because the
  trusted Design Document API is not exposed through the remote transport.
- Repositories without a recognized Design document continue to use the
  existing agent and Git behavior unless the prospective configured/default
  destination already exists. In that bootstrap case strong territory
  admission activates conservatively before semantic recognition.
