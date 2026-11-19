// DB_CHANGED covers engine mutations, including Local-only operations; filesystem watchers cover out-of-band writes.

const CHAT_MUTATIONS = new Set([
  "chats.setComposerMode",
  "chats.upsert",
  "chats.delete",
  "chats.bulkUpsert",
  "chats.clearProviderIdentity",
]);

const CODE_REVIEW_MUTATIONS = new Set([
  "codeReview.create",
  "codeReview.reply",
  "codeReview.setResolved",
]);

const PROJECT_MUTATIONS = new Set([
  "project.upsert",
  "project.remove",
  "project.rename",
  "project.bulkUpsert",
]);

const SETTINGS_MUTATIONS = new Set([
  "mcp.saveServer", "mcp.deleteServer",
  "settings.syncPreferences",
  "settings.syncAgentPreferences",
  "skills.saveZeros",
  "skills.removeZeros",
  "settings.write",
  "settings.writeRaw",
  "settings.migrateLegacy",
]);

const WORKSPACE_MUTATIONS = new Set([
  "workspace.create",
  "workspace.setStatus",
  "workspace.setMode",
  "workspace.setRemoteRestricted",
  "workspace.reassignLocalOrganization",
  // Changing working directories rewrites the checkout; refresh file lists and Git status.
  "workspace.setWorkingDirectories",
  "workspace.archive",
  "workspace.restore",
  "workspace.recover",
  "workspace.locate",
  "workspace.deleteSnapshot",
  "workspace.delete",
  "workspace.createFromBranch",
  "workspace.adoptExisting",
  "workspace.proposeBranchName",
  "workspace.continueOnNewBranch",
  // Design writes invalidate the same workspace generation used by Files and Changes.
  "design.frame.create",
  "design.page.create",
  "design.page.rename",
  "design.page.delete",
  "design.canvas.item.put",
  "design.canvas.item.delete",
  "design.themes.update",
  "design.component.move",
  "design.initialize",
  "design.transaction.apply",
  "design.history.undo",
  "design.history.redo",
  "design.frame.rename",
  "design.frame.duplicate",
  "design.frame.delete",
  "design.canvas.update",
  "design.frames.move",
  "design.node.styles",
  "design.node.transfer",
  "design.node.text",
  "design.node.html",
  "design.asset.insert",
  "design.token.update",
  "design.stage",
  "design.unstage",
  "design.review.resolve",
  "design.review.capture",
  "design.save",
  "design.commit",
  "git.initInPlace",
  "detach.start",
  "detach.stop",

  "git.stage",
  "git.unstage",
  "git.discard",
  "git.clean",
  "git.commit",
  "git.push",
  "git.pull",
  "git.rebase",
  "git.fetch",
  "git.stashSave",
  "git.stashPop",
  "git.checkoutBranch",
  "git.createBranch",
  "git.renameBranch",
  "git.changeTarget",
  "git.reset",
  "git.restore",
  "git.merge",
  "git.cherryPick",
  "git.revert",
  "git.continue",
  "git.abort",
  "git.stashApply",
  "git.stashDrop",
  "git.deleteBranch",
  "git.stageHunk",
  "git.unstageHunk",
  "git.discardHunk",
  "git.tagCreate",
  "git.tagDelete",

  "gh.publishRepo",
  "gh.prCreate",
  "gh.prUpdate",
  "gh.prMarkReady",
  "gh.prMerge",
  "gh.prComment",
  "gh.prRerunFailed",
  "gh.prSync",

  // Turn reset and undo emit a separate messages event scoped to the affected chat.
  "turns.reset",
  "turns.undoReset",

  "file.write",

  "context.graph.scaffold",
]);

/** These RPCs can complete after the renderer times out; echo DB_CHANGED to refresh the caller anyway. */
export const LONG_LIFECYCLE_OPS = new Set([

  "workspace.setWorkingDirectories",
  // Entering Design can initialize a draft; leaving can rematerialize a legacy sparse checkout.
  "workspace.setMode",
  "workspace.create",
  "workspace.createFromBranch",
  "workspace.restore",
  "workspace.recover",
  "workspace.locate",
  "workspace.archive",
  "workspace.continueOnNewBranch",

  "git.push",
  "git.pull",
  "git.fetch",
  "git.rebase",
  "gh.prCreate",
  "gh.prMarkReady",
  "gh.prMerge",
  // PR discovery can persist metadata after the caller times out.
  "gh.prSync",
  "project.reconcileGithubRemote",
]);

/** Normally skip the caller's refetch. Settings writes need an echo because the response carries the layer, not resolved settings. */
export function dbChangedIncludesOriginator(op: string, result?: unknown): boolean {
  return (
    // The engine can rename a workspace as a side effect of the chat save.
    (CHAT_MUTATIONS.has(op) && chatMutationTitledWorkspaces(result).length > 0) ||
    CODE_REVIEW_MUTATIONS.has(op) ||
    LONG_LIFECYCLE_OPS.has(op) ||
    SETTINGS_MUTATIONS.has(op) ||
    // Re-adding a repo can reconcile old workspace visibility outside the optimistic state.
    op === "project.upsert" ||
    op === "project.bulkUpsert" ||
    op === "chats.setComposerMode" ||
    // Design initialization can add files not present in the caller's retained Files and Changes caches.
    op === "design.initialize" ||
    // Design does not update the retained Code view's Git-status cache.
    op === "design.stage" ||
    // Ownership reassignment has no optimistic renderer update.
    op === "workspace.reassignLocalOrganization"
  );
}

export function chatMutationTitledWorkspaces(result: unknown): string[] {
  const ids = result && typeof result === "object"
    ? (result as { workspaceIds?: unknown }).workspaceIds
    : undefined;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
}

export function dbChangedKinds(op: string, result?: unknown): string[] | null {
  if (CODE_REVIEW_MUTATIONS.has(op)) return ["codeReview"];
  if (op === "design.transaction.apply" && result && typeof result === "object" &&
      (result as { result?: { dryRun?: boolean } }).result?.dryRun === true) return null;
  if (CHAT_MUTATIONS.has(op))
    return chatMutationTitledWorkspaces(result).length > 0 ? ["chats", "workspaces"] : ["chats"];
  if (op === "project.reconcileGithubRemote")
    return result && typeof result === "object" && (result as { changed?: boolean }).changed === true
      ? ["projects", "workspaces"] : null;
  if (op === "project.upsert" || op === "project.bulkUpsert") return ["projects", "workspaces"];
  if (PROJECT_MUTATIONS.has(op)) return ["projects"];
  if (SETTINGS_MUTATIONS.has(op)) return ["settings"];
  // Recovery can rebind exact and descendant chat folders to a sibling path; peers must refresh both collections.
  if (op === "workspace.restore" || op === "workspace.recover" || op === "workspace.locate") return ["workspaces", "chats"];
  // Design registration changes affect both main-checkout Git state and private selection.
  if (
    op === "design.renameDirectory" ||
    op === "design.adoptDirectory" ||
    op === "design.removeDirectory"
  )
    return ["workspaces", "settings"];
  // Periodic PR discovery should invalidate only when it actually persists a PR.
  if (op === "gh.prSync" && result == null) return null;
  if (
    op === "workspace.reassignLocalOrganization" &&
    !!result &&
    typeof result === "object" &&
    (result as { changes?: unknown }).changes === 0
  ) {
    return null;
  }
  if (
    op === "context.graph.scaffold" &&
    !!result &&
    typeof result === "object" &&
    (result as { created?: boolean }).created !== true
  ) {
    return null;
  }
  if (WORKSPACE_MUTATIONS.has(op)) return ["workspaces"];
  return null;
}
