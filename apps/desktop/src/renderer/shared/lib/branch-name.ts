// The renderer's door onto the shared branch-name rules.
//
// Until 2026-07-29 this file held a hand-copied MIRROR of engine/git/naming.ts,
// because that module pulls `node:crypto` for the colour allocator and cannot
// enter the browser bundle. The copy was the problem it was meant to solve: the
// rules then existed in three places (engine, here, and the settings pane's own
// validator) with a "change both together" comment as the only enforcement, and
// the failure mode was silent — Settings → Git previewing `hello/Cream` while
// the engine wrote `zeros/Cream`.
//
// Only the ALLOCATOR needs crypto, so the rules were split into
// engine/git/branch-naming.ts, which imports nothing. Both processes now read
// one definition. This file stays as the renderer's import path (five call
// sites across shell/ and features/) and as the place to explain why importing
// from `engine/` is correct here rather than a layering slip.
//
// Precedent: engine/settings/env-names.ts, imported the same way by
// renderer/features/agent/env-vault.ts.

export {
  branchDisplayName,
  DEFAULT_BRANCH_PREFIX,
  joinBranchPrefix,
  normalizeBranchPrefix,
} from "../../../engine/git/branch-naming";
