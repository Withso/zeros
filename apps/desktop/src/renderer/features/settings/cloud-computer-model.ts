// Presentation model for Settings → Cloud Computer. The organization's
// configured repositories are the desired state; the active build is what is
// live. Unbuilt changes are the difference, ignoring build outputs (pinned
// commits, observed branches) and repository order.
import type { CloudV2Build, CloudV2RepositoryDraft } from "../../platform/cloud-v2";

export type ComputerChange = "repositories" | "branches" | "setup";
const CHANGE_LABEL: Record<ComputerChange, string> = { repositories: "repositories", branches: "branches", setup: "setup" };

/** The editable part of a build's recipe. */
export function editableRepositories(build: Pick<CloudV2Build, "recipe"> | null | undefined): CloudV2RepositoryDraft[] {
  return (build?.recipe.repositories ?? []).map(({ repository, ref, setup }) =>
    ({ repository, ...(ref ? { ref } : {}), ...(setup ? { setup } : {}) }));
}

/** What differs between the configured repositories and the live build. */
export function computerChanges(configured: readonly CloudV2RepositoryDraft[], live: readonly CloudV2RepositoryDraft[]): ComputerChange[] {
  const key = (row: CloudV2RepositoryDraft) => row.repository.toLowerCase();
  const before = new Map(live.map(row => [key(row), row]));
  const changes = new Set<ComputerChange>();
  if (configured.length !== live.length || configured.some(row => !before.has(key(row)))) changes.add("repositories");
  for (const row of configured) {
    const previous = before.get(key(row));
    if (!previous) continue;
    if ((row.ref ?? "") !== (previous.ref ?? "")) changes.add("branches");
    if ((row.setup ?? "") !== (previous.setup ?? "")) changes.add("setup");
  }
  return (["repositories", "branches", "setup"] as const).filter(change => changes.has(change));
}

export function describeChanges(changes: readonly ComputerChange[]): string {
  return `Changed: ${changes.map(change => CHANGE_LABEL[change]).join(", ")}`;
}

/** Short relative age: "just now", "5m ago", "3h ago", "13d ago", "3mo ago", "1y ago". */
export function relativeAge(iso: string | null | undefined, now: number): string | null {
  const at = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(at)) return null;
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return months < 12 ? `${months}mo ago` : `${Math.floor(days / 365)}y ago`;
}

const FAILURE: Record<string, string> = {
  computer_clone_failed: "A repository could not be cloned.",
  computer_setup_failed: "A setup script failed.",
  computer_build_interrupted: "The build was interrupted.",
  computer_base_missing: "The previous computer was missing, so the next build starts fresh.",
  computer_build_creator_missing: "The person who built it no longer has access.",
  computer_remove_failed: "A removed repository could not be deleted.",
  worker_runtime_install_failed: "The workspace runtime could not be installed.",
};
export const buildFailure = (code: string | null) => (code && FAILURE[code]) ?? "The build failed.";

export type ComputerStatus =
  | { kind: "loading"; title: string; detail: null }
  | { kind: "building"; title: string; detail: string }
  | { kind: "unbuilt"; title: string; detail: string }
  | { kind: "failed"; title: string; detail: string }
  | { kind: "built"; title: string; detail: string | null }
  | { kind: "empty"; title: string; detail: string };

export function computerStatus(input: {
  builds: readonly CloudV2Build[]; activeBuildId: string | null; changes: readonly ComputerChange[]; configuredCount: number; now: number;
  /** False until the first read answers; nothing is claimed before then. */
  loaded?: boolean;
}): ComputerStatus {
  if (input.loaded === false) return { kind: "loading", title: "Loading Cloud Computer…", detail: null };
  const latest = input.builds[0];
  if (latest && (latest.state === "queued" || latest.state === "building"))
    return { kind: "building", title: "Building computer…", detail: `Build #${latest.version}${reasonSuffix(latest)}` };
  if (input.changes.length) return { kind: "unbuilt", title: "Unbuilt changes", detail: describeChanges(input.changes) };
  const active = input.builds.find(build => build.id === input.activeBuildId);
  if (latest && latest.state === "failed" && latest.id !== input.activeBuildId)
    return { kind: "failed", title: `Last build failed ${relativeAge(latest.finishedAt ?? latest.createdAt, input.now) ?? ""}`.trim(), detail: buildFailure(latest.errorCode) };
  if (active) return { kind: "built", title: `Last build ${relativeAge(active.finishedAt ?? active.createdAt, input.now) ?? ""}`.trim(), detail: null };
  return { kind: "empty", title: "No build yet",
    detail: input.configuredCount ? "Build the computer to start cloud workspaces from it." : "Add a repository below, then build the computer." };
}

function reasonSuffix(build: CloudV2Build): string {
  if (build.reason === "runtime") return " · runtime update";
  if (build.reason === "refresh") return " · daily refresh";
  if (build.recipe.rebuiltFrom) return ` · from #${build.recipe.rebuiltFrom}`;
  return "";
}

export function historyNote(build: CloudV2Build): string | null {
  if (build.reason === "runtime") return "Runtime update";
  if (build.reason === "refresh") return "Daily refresh";
  if (build.recipe.rebuiltFrom) return `From #${build.recipe.rebuiltFrom}`;
  return null;
}

/** Saves edits one at a time, in order. The first edit after a quiet period
 * takes the revision the view showed; each save then advances it, so a newer
 * server revision fetched meanwhile (another admin's edit) is a conflict, not
 * a silent overwrite. Edits during a save are coalesced into the next one; an
 * error drops what is queued, since the server's version now wins. */
export class RecipeSaveQueue<T> {
  private queued: { value: T } | null = null;
  private flight: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** The revision pending edits are based on; undefined while nothing is pending. */
  private base: number | undefined;
  /** Why the last drain stopped; settle() reports it once. */
  private failure: { error: unknown } | null = null;

  constructor(private readonly deps: {
    /** Saves `value` at `revision` and returns the new revision. */
    save(value: T, revision: number): Promise<number>;
    /** The revision currently shown when no edit is pending. */
    serverRevision(): number | undefined;
    onError(error: unknown): void;
    onSaved(): void;
  }) {}

  push(value: T, delayMs = 0): void {
    if (!this.pending) this.base = this.deps.serverRevision();
    this.failure = null;
    this.queued = { value };
    clearTimeout(this.timer); this.timer = undefined;
    if (delayMs > 0) this.timer = setTimeout(() => { void this.flush(); }, delayMs);
    else void this.flush();
  }

  flush(): Promise<void> {
    clearTimeout(this.timer); this.timer = undefined;
    this.flight ??= this.drain().finally(() => { this.flight = null; });
    return this.flight;
  }

  /** Resolves once every pushed edit has been saved; rejects when one was not,
   * so nothing acts on a configuration the server never received. */
  async settle(): Promise<void> {
    if (this.timer) void this.flush();
    while (this.flight) await this.flight;
    const failure = this.failure;
    this.failure = null;
    if (failure) throw failure.error;
  }

  /** Drops edits that have not started saving. A save already sent completes. */
  cancel(): void { clearTimeout(this.timer); this.timer = undefined; this.queued = null; if (!this.flight) this.base = undefined; }

  get waiting(): boolean { return this.timer !== undefined; }

  /** The revision to act on: the pending edits' base, else the server's. */
  revision(): number | undefined { return this.pending ? this.base : this.deps.serverRevision(); }

  private get pending(): boolean { return this.queued !== null || this.flight !== null || this.timer !== undefined; }

  private async drain(): Promise<void> {
    let saved = false;
    while (this.queued) {
      const { value } = this.queued;
      // This save takes the edit a typing pause was waiting for.
      this.queued = null; clearTimeout(this.timer); this.timer = undefined;
      const revision = this.base ?? this.deps.serverRevision();
      if (revision === undefined) return;
      try { this.base = await this.deps.save(value, revision); saved = true; }
      catch (error) { this.queued = null; this.base = undefined; this.failure = { error }; this.deps.onError(error); return; }
    }
    if (!this.timer) this.base = undefined;
    if (saved && !this.timer) this.deps.onSaved();
  }
}
