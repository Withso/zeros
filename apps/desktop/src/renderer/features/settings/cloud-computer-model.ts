import type { CloudV2Build, CloudV2RepositoryDraft } from "../../platform/cloud-v2";

export type ComputerChange = "repositories" | "branches" | "setup";
const CHANGE_LABEL: Record<ComputerChange, string> = { repositories: "repositories", branches: "branches", setup: "setup" };

// Strip build outputs before comparing the live build with the configured recipe.
export function editableRepositories(build: Pick<CloudV2Build, "recipe"> | null | undefined): CloudV2RepositoryDraft[] {
  return (build?.recipe.repositories ?? []).map(({ repository, ref, setup, setupScript }) =>
    ({ repository, ...(ref ? { ref } : {}), ...(setup ? { setup } : {}), ...(setupScript ? { setupScript } : {}) }));
}

// Repository order and case do not make a recipe unbuilt.
export function computerChanges(configured: readonly CloudV2RepositoryDraft[], live: readonly CloudV2RepositoryDraft[]): ComputerChange[] {
  const key = (row: CloudV2RepositoryDraft) => row.repository.toLowerCase();
  const before = new Map(live.map(row => [key(row), row]));
  const changes = new Set<ComputerChange>();
  if (configured.length !== live.length || configured.some(row => !before.has(key(row)))) changes.add("repositories");
  for (const row of configured) {
    const previous = before.get(key(row));
    if (!previous) continue;
    if ((row.ref ?? "") !== (previous.ref ?? "")) changes.add("branches");
    if ((row.setup ?? "") !== (previous.setup ?? "") || (row.setupScript ?? "") !== (previous.setupScript ?? "")) changes.add("setup");
  }
  return (["repositories", "branches", "setup"] as const).filter(change => changes.has(change));
}

export function describeChanges(changes: readonly ComputerChange[]): string {
  return `Changed: ${changes.map(change => CHANGE_LABEL[change]).join(", ")}`;
}

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
  computer_install_script_failed: "The install script failed. Its output is in the build's log.",
  computer_build_interrupted: "The build was interrupted.",
  computer_base_missing: "The previous computer was missing, so the next build starts fresh.",
  computer_build_creator_missing: "The person who built it no longer has access.",
  computer_cloud_unavailable: "Cloud workspaces were turned off for this organization, so it stopped.",
  computer_remove_failed: "A removed repository could not be deleted.",
  computer_shared_base_missing: "Zeros's shared base is not available right now, so nothing changed. Build again later, or add an install script to build your own base.",
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
  /** Ready copies: the Cloud Computer holds tools only, and Zeros prepares it (base: as the server finds it). */
  readyCopies?: boolean;
  base?: { state: string; errorCode?: string | undefined } | undefined;
}): ComputerStatus {
  if (input.loaded === false) return { kind: "loading", title: "Loading Cloud Computer…", detail: null };
  const latest = input.builds[0];
  if (latest && (latest.state === "queued" || latest.state === "building"))
    return latest.automatic
      ? { kind: "building", title: "Preparing the Cloud Computer…", detail: "Prepared automatically by Zeros. Workspaces can be created meanwhile." }
      : { kind: "building", title: "Building computer…", detail: `Build #${latest.version}${reasonSuffix(latest)}` };
  if (input.readyCopies && input.base?.state === "failed")
    return { kind: "failed", title: "The Cloud Computer could not be prepared", detail: `${buildFailure(input.base.errorCode ?? null)} Zeros tries again automatically.` };
  if (input.changes.length) return { kind: "unbuilt", title: "Unbuilt changes", detail: describeChanges(input.changes) };
  const active = input.builds.find(build => build.id === input.activeBuildId);
  if (latest && latest.state === "failed" && latest.id !== input.activeBuildId)
    return { kind: "failed", title: `Last build failed ${relativeAge(latest.finishedAt ?? latest.createdAt, input.now) ?? ""}`.trim(), detail: buildFailure(latest.errorCode) };
  if (active && input.readyCopies && sharedBase(active))
    return { kind: "built", title: "Uses the standard Zeros tools", detail: "Add an install script to customise it." };
  // A build nobody pressed is said so, with its date, so an admin can see it.
  if (active?.automatic) return { kind: "built", title: `Rebuilt automatically on ${calendarDay(active.finishedAt ?? active.createdAt)}`,
    detail: "Zeros prepared it with this organization's install script." };
  if (active) return { kind: "built", title: `Last build ${relativeAge(active.finishedAt ?? active.createdAt, input.now) ?? ""}`.trim(), detail: null };
  if (input.readyCopies) return { kind: "empty", title: "No build yet", detail: "Zeros prepares it with your first project or workspace." };
  return { kind: "empty", title: "No build yet",
    detail: input.configuredCount ? "Build the computer to start cloud workspaces from it." : "Add a repository below, then build the computer." };
}

/** The shared Zeros base: no machine of the organization's own, its snapshot a reference (name@build). */
const sharedBase = (build: CloudV2Build) => !!build.snapshotId?.includes("@");
const calendarDay = (at: string) => new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

function reasonSuffix(build: CloudV2Build): string {
  if (build.reason === "runtime") return " · runtime update";
  if (build.reason === "refresh") return " · daily refresh";
  if (build.recipe.rebuiltFrom) return ` · from #${build.recipe.rebuiltFrom}`;
  return "";
}

export function historyNote(build: CloudV2Build): string | null {
  if (build.automatic && sharedBase(build)) return "Standard Zeros tools";
  if (build.automatic) return build.reason === "runtime" ? "Automatic · runtime update" : "Automatic";
  if (build.reason === "runtime") return "Runtime update";
  if (build.reason === "refresh") return "Daily refresh";
  if (build.recipe.rebuiltFrom) return `From #${build.recipe.rebuiltFrom}`;
  return null;
}

// Keep the edit's base revision to detect another admin's save; coalesce later edits onto the acknowledged revision.
export class RecipeSaveQueue<T> {
  private queued: { value: T } | null = null;
  private flight: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private base: number | undefined;
  // Report a drain failure once to the caller waiting to build.
  private failure: { error: unknown } | null = null;

  constructor(private readonly deps: {
    save(value: T, revision: number): Promise<number>;
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

  // Builds wait for this drain so a failed save cannot build an older recipe.
  async settle(): Promise<void> {
    if (this.timer) void this.flush();
    while (this.flight) await this.flight;
    const failure = this.failure;
    this.failure = null;
    if (failure) throw failure.error;
  }

  // Cancel queued edits without pretending an already sent save can be undone.
  cancel(): void { clearTimeout(this.timer); this.timer = undefined; this.queued = null; if (!this.flight) this.base = undefined; }

  get waiting(): boolean { return this.timer !== undefined; }

  /** The revision to act on: the pending edits' base, else the server's. */
  revision(): number | undefined { return this.pending ? this.base : this.deps.serverRevision(); }

  private get pending(): boolean { return this.queued !== null || this.flight !== null || this.timer !== undefined; }

  private async drain(): Promise<void> {
    let saved = false;
    while (this.queued) {
      const { value } = this.queued;
      // An in-flight drain can take a queued edit before its typing timer fires.
      this.queued = null; clearTimeout(this.timer); this.timer = undefined;
      const revision = this.base ?? this.deps.serverRevision();
      if (revision === undefined) return;
      try { this.base = await this.deps.save(value, revision); saved = true; }
      catch (error) {
        // Discard queued edits on failure so the next edit starts from the shown server revision.
        this.queued = null; clearTimeout(this.timer); this.timer = undefined; this.base = undefined;
        this.failure = { error }; this.deps.onError(error); return;
      }
    }
    if (!this.timer) this.base = undefined;
    if (saved && !this.timer) this.deps.onSaved();
  }
}

// A late recipe reply must not replace a revision already seen during refresh.
export function newerRecipe<T extends { recipeRevision?: number | undefined; recipe?: unknown }>(
  fresh: T | undefined, saved: { recipe: NonNullable<T["recipe"]>; recipeRevision: number },
): T | null {
  if (!fresh || (fresh.recipeRevision ?? -1) >= saved.recipeRevision) return null;
  return { ...fresh, recipe: saved.recipe, recipeRevision: saved.recipeRevision };
}
