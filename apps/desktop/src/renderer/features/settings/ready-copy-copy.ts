// Every ready copy failure in plain words, in one place: what failed and what
// to change. The UI never shows a raw code; an unknown one reads as the last line.
export type ReadyCopyFailureCopy = { what: string; change: string };

const COPY: Record<string, ReadyCopyFailureCopy> = {
  ready_copy_setup_failed: { what: "Setup failed.", change: "Check the setup command and its output, then save it or build again." },
  ready_copy_clone_failed: { what: "The repository could not be cloned.", change: "Check that its GitHub connection can read it and that the branch exists." },
  ready_copy_secret_left: { what: "A build secret was left on the disk.", change: "Read it from the environment in setup; don't write it to a file." },
  ready_copy_secret_search_incomplete: { what: "The check for build secrets left on the disk did not finish.", change: "Build again; if it keeps failing, make the setup leave less on the disk." },
  ready_copy_scrub_failed: { what: "The build could not be cleaned up before it was saved.", change: "Build again." },
  ready_copy_boot_timeout: { what: "The build's machine did not start in time.", change: "Build again." },
  ready_copy_stop_incomplete: { what: "The build's machine did not stop.", change: "Build again." },
  ready_copy_interrupted: { what: "The build was interrupted.", change: "It is retried automatically." },
  ready_copy_superseded: { what: "A newer build replaced this one.", change: "Nothing to change." },
  ready_copy_base_changed: { what: "The Cloud Computer changed while this built.", change: "It is rebuilt from the new Cloud Computer." },
  ready_copy_project_changed: { what: "The project changed while this built.", change: "It is rebuilt from the saved project." },
  ready_copy_source_missing: { what: "The build it updates from was gone.", change: "Build again; it starts from the Cloud Computer." },
  worker_runtime_install_failed: { what: "The Zeros runtime could not be installed for the build.", change: "Build again." },
  organization_connection_required: { what: "The organization has no GitHub connection for this repository's account.", change: "Connect it in GitHub settings." },
  github_installation_required: { what: "The Zeros GitHub App is no longer installed for this repository's account.", change: "Install it again in GitHub." },
  github_installation_suspended: { what: "The Zeros GitHub App is suspended for this repository's account.", change: "Unsuspend it in GitHub." },
  github_app_access_required: { what: "The Zeros GitHub App can't read this repository.", change: "Add it to the App's repositories in GitHub." },
  project_unavailable: { what: "The project was removed, or its member left.", change: "Nothing to change here." },
  // Set on a build still running when its project went (or, with S4, the account that kept a personal project).
  project_removed: { what: "The project was removed.", change: "Nothing to change here." },
  // S4: the copy was still building when its GitHub connection was removed or the App uninstalled.
  connection_removed: { what: "Its GitHub connection was removed.", change: "Connect GitHub again in GitHub settings, then build again." },
  organization_unavailable: { what: "The organization can't use the cloud now.", change: "Nothing to change here." },
  ready_copy_failed: { what: "The project could not be built.", change: "Build again." },
};
export const READY_COPY_FAILURE_CODES = Object.keys(COPY);
export const readyCopyFailureCopy = (reason: string): ReadyCopyFailureCopy => COPY[reason] ?? COPY.ready_copy_failed!;

const TRIGGERS: Record<string, string> = {
  project_created: "Project created", repositories_changed: "Repositories changed", weekly_update: "Weekly update", computer_build: "New Cloud Computer build",
  setup_changed: "Setup changed", branch_changed: "Branch changed", secrets_changed: "Build secrets changed", retry: "Retry",
};
export function readyCopyTriggerLabel(trigger: string | null, startedBy: string | null, triggerDetail?: string): string | null {
  if (triggerDetail === "submodules_changed") return "Submodules setting changed";
  if (trigger === "manual") return startedBy ? `Started by ${startedBy}` : "Started by hand";
  return trigger ? TRIGGERS[trigger] ?? null : null;
}

/** When an automatic retry comes, in words; null means retries stopped. */
export function nextRetryWords(nextRetryAt: string | null, now: number): string {
  if (!nextRetryAt) return "Automatic retries stopped; change something or retry now.";
  const minutes = Math.max(0, Math.round((Date.parse(nextRetryAt) - now) / 60_000));
  if (minutes < 1) return "Retrying shortly.";
  if (minutes < 90) return `Next try in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
  const hours = Math.round(minutes / 60);
  return `Next try in ${hours} hour${hours === 1 ? "" : "s"}.`;
}

/** The one line for a project's failed build: which repository, what, where, what to change, when it retries. */
export function readyCopyFailureLine(failure: { reason: string; repository?: string | null; detail: string | null; nextRetryAt?: string | null }, now: number): string {
  const copy = readyCopyFailureCopy(failure.reason);
  const repository = failure.repository ? `${failure.repository}: ` : "";
  const where = failure.detail && failure.reason === "ready_copy_secret_left" ? ` In ${failure.detail}.` : "";
  return `${repository}${copy.what}${where} ${copy.change} ${nextRetryWords(failure.nextRetryAt ?? null, now)}`.replace(/\s+/g, " ").trim();
}

/** A build's submodules for one repository, as counts: "Submodules: 3 fetched, 1 skipped". Null without any. */
export function readyCopySubmodulesLine(counts: { fetched: number; skipped: number } | undefined, repository?: string): string | null {
  if (!counts || counts.fetched + counts.skipped === 0) return null;
  return `${repository ? `${repository} s` : "S"}ubmodules: ${[`${counts.fetched} fetched`, ...(counts.skipped ? [`${counts.skipped} skipped`] : [])].join(", ")}`;
}
