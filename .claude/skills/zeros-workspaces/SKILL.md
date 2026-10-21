---
name: zeros-workspaces
description: "Zeros Local and cloud workspaces: use for any change touching workspaces, the engine, bridge, Git/GitHub, agents, Design, terminals, previews, files, settings or their UI — every change must handle Local and organization owners, local and cloud placements, and switching between them."
---

<!-- GENERATED from RULES.md by scripts/design-system/build-design-docs.mjs. Edit the workspace brief there, then run `pnpm design:docs`. -->

## Agent brief: local and cloud workspaces in Zeros

Zeros runs the same product against two runtimes. Handle both on every change.

**The model**

- **Owners.** The **Local** organization is the device Personal owner
  (`isPersonal`, shown as "Local"; `organization_id` is null). Collaborative
  **organizations** (Pro, Business, Team) are tenant roots with their own
  members and roles.
- **Placement.** A workspace row has `placement` `local` or `cloud`
  (docs/organizations-and-teams.md, "Workspace placement"). Local workspaces
  run on the Mac's local engine and live in a Mac checkout or worktree; Local
  and organizations can both own them. Cloud workspaces require an
  organization: each runs a standalone worker in its own Boat VM, reached
  through the control-plane relay, with files in the VM checkout. The worker
  never imports the Local engine runtime.
- **Identity.** A cloud workspace is addressed by its `cloud://` key
  (`cloudWorkspaceKey`, `parseCloudWorkspaceKey`, `isCloudWorkspace`); a local
  workspace by its folder path. A VM-native path is never a renderer identity:
  map typed fields at the cloud wire (`cloud-runtime-wire.ts`) and fail closed
  on a foreign root.

**Rules**

1. **Cover every case.** Before writing code, state the behavior for: a Local
   workspace, an organization's local workspace, an organization's cloud
   workspace, and switching between owners and placements. Every PR body has
   "Local workspace impact" and "Cloud workspace impact" sections.
2. **Gate at the owning boundary.** Cloud-only behavior is selected by the
   cloud target (`connectionTarget.kind === "cloud"`, a `cloud://` key), the
   standalone cloud worker, or the control plane — never by a heuristic.
   A shared path must not change local behavior as a side effect; an
   intentional change for both placements is named and tested for both.
3. **Test both.** Each modified shared path carries a regression test for the
   local and the cloud case, or a test proving the local path is untouched.
   When a live check is impossible for one placement, list the exact manual
   check instead of claiming it.
4. **Cloud realities.**
   - A cloud workspace can be creating, starting, running, stopping, stopped,
     failed, deleting or deleted. Render states through the workbench status
     standard (docs/design-system.md). Archive is a separate `archivedAt` flag:
     stopped or failed workspaces with it display as archived. Restore starts
     the VM and clears the flag; idle stop never sets it.
   - Passive history reads use the control-plane mirror and never wake a VM.
     Explicit work wakes it. Running turns and recent terminal input/output
     report activity; an idle shell must not keep the VM awake indefinitely.
   - Infrastructure credentials and the agent login vault stay in the control
     plane. Claude and Cursor credentials are delivered to the VM; Codex uses
     a workspace proxy token, with ChatGPT renewal in the control plane.
     GitHub tokens come from an on-demand broker.
   - The VM is the isolation boundary, with one trust domain per workspace.
     The worker, agents, tools and terminals run as Boat's stock non-root user
     `user`, with full permissions in the VM checkout under `/home/user`.
     Session directories and child environment allowlists are not security
     boundaries; agents can access other conversations and delivered credentials
     on their VM.
   - Access is creator-only and requires current organization membership;
     enforce it on the server. Each organization has one Cloud Computer;
     organization admins manage its recipe, builds and active snapshot.
     Several devices belonging to the creator may attach and must converge.
   - Create and wake install the control plane's SHA-pinned runtime under
     `/opt/zeros/runtime/<sha256>`, reached through `/opt/zeros/worker`.
     Cloud Computer builds start from Boat's stock image and cache the runtime
     alongside installed repositories in an organization snapshot.
   - Cloud advertises no Browser, Design or simulator capability. Do not route
     an unavailable cloud feature to Local. Chat, files, Git and terminals use
     the shared UI and existing bridge messages.
   - The control plane type-checks and deploys standalone: its source never
     imports `@zeros/protocol`; mirror the contract and add a parity test.
     See [docs/cloud-workspaces.md](docs/cloud-workspaces.md) for the v2 contract.
5. **Local realities.**
   - Local workspaces work without the control plane, network access, or a
     signed-in account where the feature allows it.
   - They survive engine restarts and respawns, use worktrees, and keep local
     credentials on the Mac.
6. **Owner switching.** Views filter by the selected owner. Reads are keyed by
   exact owner, placement, and workspace; a late response for another key can
   neither render nor clear the current view.
