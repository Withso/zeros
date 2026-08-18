# Design mode — one workspace, separate authority

**Status:** Internal feature (`designWorkspaces`), current engineering and
product contract (2026-08-18).

A Zeros workspace has one semantic identity and one full checkout. `viewMode`
only selects the visible Code or Design surface; it never grants filesystem
authority. Agents, terminals, dev servers, and installs may keep running while
the user views Design, so switching views is local and immediate.

The persisted `workspaces.view_mode` column is the canonical presentation
field. `kind` remains a synchronized compatibility mirror for older call sites
and serialized clients; neither field authorizes an actor. A code agent's role
and immutable write territory are established independently when its runtime is
created.

## Current actor contract

| Actor                                | Code / repository roots                                                     | Recognized Design directories                                               | Other host state                                                                        |
| ------------------------------------ | --------------------------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Human Design surface                 | Read context; no code-write operation is exposed                            | Mutates through the trusted in-process Design Document API                  | Trusted app authority                                                                   |
| Zeros-launched local code agent      | Read/write                                                                  | Read-only, for every recognized root; contents remain readable and listable | Normal host-parity access                                                               |
| Zeros file/Git commands              | Read/write subject to command semantics                                     | Engine-owned Design mutations remain serialized                             | Trusted engine authority                                                                |
| User terminal or external editor/Git | Full same-user OS authority                                                 | Read/write                                                                  | Outside the Zeros agent boundary                                                        |
| Design-agent boundary substrate      | Repository roots read-only; minimal canonical Git metadata remains writable | Read/write for every recognized root                                        | Normal host-parity access outside admitted repository roots; no production consumer yet |

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
3. The local immutable profile preserves host write authority, then carves
   every recognized Design root and generation-private ZSR descriptor back to
   read-only. Canonical Git metadata stays ordinary and writable.
4. Every admitted additional repository root is resolved with its own Design
   territory. Multiple Design roots are first-class; none is selected merely
   by the current canvas or cwd.
5. The engine installs the exact profile with Seatbelt on macOS or a
   mount-only bubblewrap profile on Linux before any provider byte starts.
   There is no instruction-only fallback.
6. The process tree is observable and must be terminated completely before a
   changed territory can be published.

Claude, Codex, Cursor, custom/PATH tools, MCP children, shells, hooks, and
subprocesses all inherit this one external OS boundary. Provider-native
permission modes still control approval UX, but they neither establish nor
weaken the Design filesystem fence. ZSR does not replace HOME, XDG roots,
Keychain, GH/GitHub tokens, SSH agent, Git configuration, network, ports, logs,
or ordinary tool paths in the local profile. Only engine bearer/control
variables are stripped.

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

Local code agents use the canonical repository and ordinary Git executable
directly. `git -c`, checkout, reset, clean, stash, rm, commits, hooks, signing,
fetch, pull, and push retain native behavior; there is no shadow repository,
checkpoint dispatcher, remote broker, hook suppression, or stderr rewriting on
the local path. The Design directory's OS write denial remains effective when a
Git subcommand tries to modify its worktree files.

The design-agent substrate inverts the worktree policy. Repository roots are
read-only, all recognized Design roots are writable, and the smallest canonical
Git metadata directories are reopened writable. Directory islands are required:
binding an existing index file individually prevents Git's atomic replacement.
This lets native Git stage Design changes without reopening code files.

Zeros-run checkout, pull, rebase, merge, reset, stash, and turn-restore paths
share the Design mutation lane. They retire an obsolete authority map when
needed, perform the Git operation, and resolve the resulting real tree before
process admission reopens. The filesystem/Git
watcher reconciles external HEAD or settings movement and retires sessions whose
captured semantic territory no longer matches.

Mode changes themselves do not restart an agent when the territory is
unchanged. Archive, restore, delete, first Design creation, Design-directory
settings changes, and territory-changing Git rewrites use fail-closed process
drain and lifecycle sequencing.

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
- Design-surface operations remain desktop-only for relay clients, and Design
  rows remain excluded from the remote workspace list while the surface is an
  internal feature.
- Repositories without a recognized Design document continue to use the
  existing agent and Git behavior unless the prospective configured/default
  destination already exists. In that bootstrap case strong territory
  admission activates conservatively before semantic recognition.
