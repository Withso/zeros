# Design mode — one workspace, separate authority

**Status:** Internal feature (`designWorkspaces`), current engineering and
product contract (2026-08-13).

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

| Actor                                | Code                                             | Recognized Design directories                                                                      | Enforcement today                                                                             |
| ------------------------------------ | ------------------------------------------------ | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Human Design surface                 | Read context; no code-write operation is exposed | Mutates through the trusted in-process Design Document API                                         | Typed transactions, revision checks, one workspace mutation lane                              |
| Zeros-launched code agent            | Read/write                                       | Read-only                                                                                          | Qualified pinned provider runtime plus OS sandbox; startup fails closed                       |
| Zeros file/Git commands              | Read/write subject to command semantics          | Generic writes/staging rejected; `design.save` and serialized Git rewrites are brokered exceptions | Engine path validation and mutation lanes                                                     |
| User terminal or external editor/Git | Full same-user OS authority                      | Read/write                                                                                         | Outside the Zeros agent boundary                                                              |
| Future design agent                  | Not shipped                                      | Not shipped                                                                                        | Must receive code-read-only capability and mutate Design only through an authorized typed API |

Reads are intentionally broad: code agents may inspect Design and designers may
inspect code. Write authority is asymmetric and does not follow the selected UI
surface.

## Code-agent containment promise

For a workspace with a recognized Design territory, Zeros starts a code agent
only when all of these conditions hold:

1. The canonical workspace root and active `[design] directory` are resolved at
   each new-session or resume admission.
2. The active directory and every other committed Design document in the
   checkout are real, symlink-free directory paths. The actual trees are walked,
   so ignored and untracked drafts and nested directories are covered. A
   pre-existing Design file with more than one hard link refuses admission.
3. The immutable territory grants workspace write, then carves every recognized
   Design root, `.zeros` policy, and the worktree/common Git metadata back to
   read-only.
4. The territory has one canonical workspace root. Provider `/add-dir` roots
   are removed for contained sessions because they grant another writable
   working directory outside the aliases and lifecycle validated at admission.
   A Design-bearing workspace and cwd must also use their canonical physical
   spelling; symlink/case aliases and provider launch-path/wrapper overrides are
   refused or removed, as are generic startup-injection environment names.
   Ordinary code-only workspaces retain existing behavior.
5. The provider must install that exact profile with an OS-enforced sandbox on
   a qualified host before the session is admitted. There is no
   instruction-only fallback.
6. The process tree is observable and must be terminated completely before a
   changed territory can be published.

Current qualified paths are the Zeros-pinned Codex and Claude runtimes on macOS
and Linux:

- Codex receives a named, highest-precedence permission profile with exact
  read-only carve-outs. Ask, Auto, Full Access, and Read Only change approval
  behavior but do not replace this profile.
- Claude Code is pinned at 2.1.231 (and admission enforces a 2.1.228 minimum,
  the documented built-in Write path-rule floor). It receives strict sandbox
  startup (`failIfUnavailable`), workspace `allowWrite`, exact `denyWrite`, and
  highest-precedence built-in Edit denies. Native bypass is clamped to
  `acceptEdits` for a territory-bearing session. User/project settings, hooks,
  plugins, MCP tools, workflows, artifacts, and native subagents are disabled
  for that session because they are independent authority paths. Claude's
  administrator-managed policy tier remains active even with those ordinary
  settings sources disabled, so admission inspects it and refuses policy that
  replaces flag permission rules, weakens/disables isolation, widens write or
  host-service access, or executes helpers/hooks/plugins. Its `Edit(...)`
  syntax has no verified literal encoding for glob, bracket, parenthesis,
  backslash, newline, or NUL characters, so Claude admission rejects any
  absolute denied path containing them. Codex's exact-path profile is
  unaffected.
- Custom or PATH provider executables are not qualified for Design-bearing
  sessions. They remain available for ordinary code-only sessions.
- Cursor does not currently expose a sufficient path-scoped boundary and is
  refused in a Design-bearing workspace.

The code-agent runtime receives no Design API or Design MCP tool. Engine bearer
credentials are not written into its workspace or environment. The territory
instruction is still injected on the provider's native system/developer channel
as defense in depth, but prose is not the boundary.

This is a scoped security guarantee, not a claim against kernel compromise,
provider sandbox bugs, root/administrator access, or a trusted human using a
separate terminal. It applies to Zeros-launched code-agent process trees on a
qualified provider/OS combination. If the profile, runtime, tree validation, or
process teardown cannot be proved, the agent does not start or the authority
transition does not complete. A provider pathname that cannot be encoded
literally, a non-canonical workspace alias, or an incompatible Claude managed
policy is likewise an admission failure, not a reason to broaden a deny pattern
or downgrade the guarantee. A hostile root/MDM administrator remains outside
the same-user agent threat model.

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

A Git index is one file, so a path-scoped OS policy cannot allow `git add` for
code while denying it for Design in the same canonical index. In a
Design-bearing workspace, code-agent Git metadata is therefore read-only. The
agent can inspect Git and edit code; Zeros-owned Git operations stage, commit,
and integrate through the engine. Future autonomous commit/publish work should
run in a private overlay and return a validated ChangeSet rather than weakening
the canonical boundary.

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
- A future **Design Orchestration API** will let a code conversation request
  `design.explore`, query status, cancel work, and receive artifact references.
  It will spawn a separately authorized design actor; it will not give the code
  agent raw Design-file mutation tools.

No design agent or code-to-design orchestration endpoint is wired today.

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
