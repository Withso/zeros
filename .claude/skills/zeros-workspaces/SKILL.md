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
  organization: they run on that organization's cloud engine in a VM, are
  reached through the control-plane bridge, and keep their files in the VM
  checkout.
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
   engine's cloud worker mode, or the control plane — never by a heuristic.
   A shared path must not change local behavior as a side effect; an
   intentional change for both placements is named and tested for both.
3. **Test both.** Each modified shared path carries a regression test for the
   local and the cloud case, or a test proving the local path is untouched.
   When a live check is impossible for one placement, list the exact manual
   check instead of claiming it.
4. **Cloud realities.**
   - A cloud VM can be setting up, starting, running, idle-sleeping, stopping,
     stopped, failed, or archived. Every surface renders each state through the
     workbench status standard (docs/design-system.md).
   - Passive reads never wake a VM; explicit user actions follow the idle and
     wake policy.
   - Credentials stay outside the VM except bounded per-operation grants.
   - Actor roles (prompter, developer, manager, owner) gate actions on the
     server, not only in the UI.
   - Several devices attach at once and must converge.
   - New engine code reaches an existing cloud workspace only after its
     runtime is upgraded; a restart keeps the generation's runtime pin.
   - The control plane type-checks and deploys standalone: its source never
     imports `@zeros/protocol`; mirror the contract and add a parity test.
5. **Local realities.**
   - Local workspaces work without the control plane, network access, or a
     signed-in account where the feature allows it.
   - They survive engine restarts and respawns, use worktrees, and keep local
     credentials on the Mac.
6. **Owner switching.** Views filter by the selected owner. Reads are keyed by
   exact owner, placement, and workspace; a late response for another key can
   neither render nor clear the current view.
