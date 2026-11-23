// An in-memory Alpha for the rehearsal's unit tests: the API routes, bridge ops, Boat, R2, GitHub and database reads
// the stages use, with a retention lifecycle that advances when a test shifts a workspace's clock. Every port call is
// counted so a test can fail the n-th one, before or after its effect.
import { randomUUID } from "node:crypto";
import { WORKSPACE_REPOSITORIES_FEATURE } from "../contract.js";
import { connectWorkspace } from "../rehearsal/steps.js";
import { RehearsalFailure, type Api, type ApiReply, type Bridge, type Ports, type ProGrant, type ProPort, type Query } from "../rehearsal/contract.js";

type Workspace = {
  id: string; name: string; organizationId: string; state: string; branch: string; boatSandboxId: string; projectId?: string;
  archivedAt: string | null; activeAt: string; updatedAt: string; keep: boolean; archiveReason?: string;
  repositories?: { repository: string; checkoutPath: string; branch: string; baseBranch: string }[];
  files: Map<string, string>; seeded: Map<string, string>; commits: Map<string, string[]>; pushed: Set<string>;
  // Retention, in days since the stop.
  /** The Cloud Computer build it was created or last rebuilt from. */
  computerBuildId?: string | null;
  /** Created while the base was being prepared (#1260): the build it waits for, and when it was created. */
  waitingFor?: string; createdAtMs?: number; errorCode?: string;
  stoppedDays: number | null; archivedAtDays?: number; probe?: "clean" | "dirty"; backup: boolean;
  /** Stop generations, as the product counts them: a backup covers only the stop it was taken for. */
  stopGeneration?: number; backupGeneration?: number; wakes: number; scrub: string | null; machineGone: boolean; lostWork?: boolean;
};
type Build = { id: string; state: string; snapshot: string | null; builderSandboxId: string | null; automatic?: boolean; shared?: boolean;
  createdAt?: number; readyAt?: number };
type Project = { id: string; name: string; organizationId: string; repositories: string[]; machine: string; submodules: boolean;
  /** Its latest copy's failure reason, or null when it is ready. */
  copyFailed?: string | null };
type Turn = { chatId: string; turnId: string; startedAt: number; files: string[] };

export class FakeAlpha {
  readonly organizationId = randomUUID();
  readonly workspaces = new Map<string, Workspace>();
  readonly projects = new Map<string, Project>();
  readonly machines = new Map<string, { name: string; state: string }>();
  readonly objects = new Set<string>();
  readonly repositories = new Map<string, { branches: Set<string>; pulls: Map<number, { head: string; open: boolean }> }>();
  readonly forks = new Set<string>();
  readonly turns: Turn[] = [];
  /** The account's environments by repository id: what a PATCH wrote, and the revision it is at. */
  readonly environments = new Map<string, { revision: number; files: Map<string, string> }>();
  /** Whether the fixtures' .gitignore names .env. */
  ignoresEnv = true;
  /** The Personal organization's Cloud Computer: its active base build, and the builds; Boat's named snapshots. */
  computer: { active: string | null; builds: Build[] } = { active: null, builds: [] };
  /** The server prepares the organization's base itself (#1260): a project or a create queues an automatic one, ready after
   * baseBuildMs. False: a server before #1260, whose overview reports no base. */
  automaticBase = true;
  baseBuildMs = 5 * 60_000;
  /** #1260's F1, as it was: a create that waited past the 10-minute boot deadline fails right after its machine boots. */
  bootDeadlineFromCreate = false;
  /** CLOUD_V2_SHARED_BASE_SNAPSHOT set and the organization has no install script: its base is live at once, no machine. */
  sharedBase = false;
  /** What Boat reports as a machine's last snapshot attempt (the rehearsal prints it). */
  snapshotStatus = "completed";
  /** Providers connected by a credential this run did not make (a person's own), as GET agent-connections reads them. */
  agentConnections: string[] = ["claude"];
  /** The account's agent credentials and the organization's selections, as the credential routes keep them. */
  readonly agentCredentials = new Map<string, { kind: string; revoked: boolean; revision: number; organizationId: string | null }>();
  readonly agentSelections = new Map<string, { credentialId: string | null; revision: number }>();
  /** A credential value the fake received, kept only to prove it never reaches a printed line. */
  readonly agentMaterialValues: string[] = [];
  /** What AGENT_NEW_SESSION answers instead of a session (e.g. an error frame for an agent with no credential). */
  sessionReply: ({ type: string } & Record<string, unknown>) | null = null;
  /** A create that fell back to a direct clone: no fork record. */
  forkFallback = false;
  /** A create whose fork lacked a checkout: cloned directly, and the copy it forked marked stale (#1263's distrust). */
  copyDistrusted = false;
  /** Failure reasons the next copies fail with, one per copy build (a create, then each retry); empty: ready. */
  copyFailures: string[] = [];
  copyRetries = 0;
  /** What the provider said of the copy's archive when it was promoted (cloud_v2_ready_copies.archive_snapshot). */
  copyArchive: string | null = "completed";
  /** The organization's install script (#1260: with one, its base is its own build, never the shared one). */
  installScript: string | null = null;
  private recipeRevision = 0;
  readonly snapshots = new Set<string>();
  /** Behave as main did before the clean-restore fix: a rebuilt workspace keeps its earlier pin. */
  staleRestorePin = false;
  /** Whether the account has its own GitHub sign-in (on the organization route); on the Personal route, set by its token connect. */
  githubIdentity = true;
  patConnected = false;
  readonly userId = randomUUID();
  /** The account's operator Pro grant; null: none. */
  proGrant: ProGrant | null | "foreign" = null;
  private proEndedAt: number | null = null;
  /** What the stop recorded about the worker unit. */
  workerOff = true;
  transactions = 0;
  readonly writes: string[] = [];
  readonly shifts: { ids: string[]; days: number }[] = [];
  /** Every string the run made visible on GitHub (all fixtures are public): pushed branch names, commit messages and
   * committed file contents, and pull request titles and bodies. */
  readonly published: string[] = [];
  private readonly unpushed = new Map<string, string[]>();
  /** Retention S4's table: present unless a test removes it. */
  s4 = true;
  now = 1_700_000_000_000;
  calls = 0;
  /** Fail the n-th port call: before its effect, or after it (a lost response). */
  fault?: { at: number; after: boolean };
  private nextPull = 1;
  private nextMachine = 1;

  constructor(fixtures: string[]) { for (const name of fixtures) this.repositories.set(name.toLowerCase(), { branches: new Set(["main"]), pulls: new Map() }); }

  private async counted<T>(work: () => T | Promise<T>): Promise<T> {
    const n = ++this.calls, fault = this.fault?.at === n ? this.fault : undefined;
    if (fault && !fault.after) throw new RehearsalFailure("injected", "fault");
    const result = await work();
    if (fault) throw new RehearsalFailure("injected", "fault");
    return result;
  }
  private machine(name: string): string {
    const id = `m-${this.nextMachine++}`;
    this.machines.set(id, { name, state: "running" });
    return id;
  }
  private reply(status: number, body: unknown = {}): ApiReply { return { status, body }; }
  private document(row: Workspace) {
    const archived = row.archivedAt !== null;
    return { id: row.id, number: [...this.workspaces.keys()].indexOf(row.id) + 1, name: row.name, organizationId: row.organizationId, state: row.state, branch: row.branch,
      boatSandboxId: row.boatSandboxId || null, ...(row.errorCode ? { errorCode: row.errorCode } : {}),
      ...(row.waitingFor && row.state === "creating" ? { preparing: "computer" } : {}),
      archivedAt: row.archivedAt, activeAt: row.activeAt, updatedAt: row.updatedAt, keep: row.keep, ...(row.projectId ? { projectId: row.projectId } : {}),
      ...(row.repositories ? { repositories: row.repositories } : {}), ...(archived && row.archiveReason ? { archiveReason: row.archiveReason } : {}),
      // As store.ts archiveFields: an estimate (the last stop + 24 days, or + 14 once the archived wake ran) already past is
      // left out; the archived wake (scrub set) stopped the machine just now.
      ...(archived && (row.scrub !== null || (row.stoppedDays ?? 0) < 24) ? { machineExpectedGoneAt: { at: new Date(this.now).toISOString(), estimate: true } } : {}),
      ...(archived && row.backup ? { backupRemovalAt: new Date(this.now).toISOString() } : {}),
      ...(this.s4 && archived ? { restores: { code: row.backup ? "backup" : "github" } } : {}),
      ...(row.lostWork ? { lostWork: { restored: "none", stoppedAt: new Date(this.now).toISOString() } } : {}) };
  }

  /** The organization's base, made sure of as computer.ts ensureBase does: the live one, the one building, or a new
   * automatic one (its builder machine counted). Null with the base switch off. */
  private ensureBase(): Build | null {
    if (!this.automaticBase) return null;
    const live = this.computer.builds.find(build => build.id === this.computer.active && build.state === "succeeded");
    if (live) return live;
    const building = this.computer.builds.find(build => build.state === "building");
    if (building) return building;
    if (this.sharedBase && this.installScript === null) {
      const shared: Build = { id: randomUUID(), state: "succeeded", snapshot: `zeros-shared@${randomUUID()}`, builderSandboxId: null, automatic: true, shared: true, createdAt: this.now };
      this.computer.builds.unshift(shared); this.computer.active = shared.id; this.snapshots.add("zeros-shared");
      return shared;
    }
    const build: Build = { id: randomUUID(), state: "building", snapshot: null, builderSandboxId: this.machine("base builder"), automatic: true,
      createdAt: this.now, readyAt: this.now + this.baseBuildMs };
    this.computer.builds.unshift(build);
    return build;
  }
  private baseView(): { state: string } {
    if (this.computer.builds.some(build => build.id === this.computer.active && build.state === "succeeded")) return { state: "ready" };
    return { state: this.computer.builds.some(build => build.state === "building") ? "preparing" : "none" };
  }

  /** The retention lifecycle, run on every database read and clock sleep. */
  tick(): void {
    for (const build of this.computer.builds) {
      if (build.state !== "building" || build.readyAt === undefined || build.readyAt > this.now) continue;
      build.state = "succeeded"; build.snapshot = `zeros-alpha-${this.computer.builds.length}`; this.snapshots.add(build.snapshot);
      if (build.builderSandboxId) this.machines.get(build.builderSandboxId)!.state = "deleted";
      this.computer.active = build.id;
      for (const row of this.workspaces.values()) {
        if (row.waitingFor !== build.id || row.state !== "creating") continue;
        delete row.waitingFor;
        if (this.bootDeadlineFromCreate && this.now - (row.createdAtMs ?? this.now) > 10 * 60_000) { row.state = "failed"; row.errorCode = "worker_boot_timeout"; continue; }
        row.state = "running"; row.boatSandboxId = this.machine(`${row.name} from base`);
      }
    }
    if (this.proEndedAt !== null && this.now - this.proEndedAt >= 20 * 60_000)
      for (const row of this.workspaces.values()) if (row.state === "running") { row.state = "stopped"; row.stoppedDays = 0; this.machines.get(row.boatSandboxId)!.state = "stopped"; }
    for (const row of this.workspaces.values()) {
      if (row.state !== "stopped" || row.stoppedDays === null) continue;
      if (row.probe === "dirty" && row.backupGeneration !== (row.stopGeneration ?? 0) && row.stoppedDays >= 1 / 24) {
        row.backup = true; row.backupGeneration = row.stopGeneration ?? 0; this.objects.add(`cloud-v2/checkpoints/${row.id}/a.zck`);
      }
      if (row.archivedAt === null && row.stoppedDays >= 10 && row.wakes === 0) row.wakes = 1;
      if (row.archivedAt === null && !row.keep && row.stoppedDays >= 30) {
        row.archivedAt = new Date(this.now).toISOString(); row.archiveReason = "inactive"; row.archivedAtDays = row.stoppedDays;
      }
      // The archived wake, ten days after the archive.
      if (row.archivedAt !== null && row.scrub === null && row.stoppedDays >= (row.archivedAtDays ?? 0) + 10) { row.scrub = row.backup && row.seeded.size > 0 ? "backup" : "clean"; row.wakes++; }
      if (this.s4 && row.archivedAt !== null && row.backup && row.stoppedDays >= 61 && row.archiveReason === "manual") {
        row.backup = false; for (const key of [...this.objects]) if (key.includes(row.id)) this.objects.delete(key);
      }
    }
  }

  pro(): boolean {
    const grant = this.proGrant;
    return grant !== null && grant !== "foreign" && grant.enabled && (grant.validUntil === null || Date.parse(grant.validUntil) > this.now);
  }
  readonly proChanges: ProGrant[] = [];
  proPort(): ProPort {
    return {
      read: () => this.counted(() => this.proGrant === null || this.proGrant === "foreign" ? this.proGrant : { ...this.proGrant }),
      change: (grant, reason) => this.counted(() => {
        if (this.proGrant === "foreign") throw new RehearsalFailure("pro_change", "foreign_grant");
        if (reason.length < 16) throw new RehearsalFailure("pro_change", "reason");
        const was = this.pro();
        this.proGrant = { ...grant }; this.proChanges.push({ ...grant });
        if (was && !this.pro()) this.proEndedAt = this.now; else if (this.pro()) this.proEndedAt = null;
        return randomUUID();
      }),
    };
  }
  /** A second test account: a stranger to this organization, who reaches none of it. */
  otherApi(): Api {
    return { json: (method, path) => this.counted(() => {
      if (method !== "GET") this.writes.push(`other ${method} ${path.replace(/[0-9a-f-]{36}/g, ":id")}`);
      if (path.startsWith("/v1/cloud-v2/workspaces?")) return this.reply(403, { error: { code: "forbidden" } });
      return this.reply(404, { error: { code: "not_found" } });
    }) };
  }

  api(): Api {
    return { json: (method, path, body, headers) => this.counted(() => this.route(method, path, body as Record<string, unknown> | undefined, headers)) };
  }

  private route(method: string, path: string, body: Record<string, unknown> = {}, headers: Record<string, string> = {}): ApiReply {
    if (method !== "GET") this.writes.push(`${method} ${path.replace(/[0-9a-f-]{36}/g, ":id")}`);
    const url = new URL(path, "https://alpha.test"), parts = url.pathname.split("/").filter(Boolean);
    // A Personal organization whose Pro ended has no cloud: its GitHub connection, projects and workspace list answer 404
    // (organization), as Alpha's do; a workspace's own routes answer 403 pro_required (below).
    if (this.proGrant !== null && this.proGrant !== "foreign" && !this.pro() && (url.pathname === "/v1/cloud-v2/github/connection" || parts[4] === "cloud-projects"
      || parts[4] === "computer" || (url.pathname === "/v1/cloud-v2/workspaces" && method === "GET")))
      return this.reply(404, { error: { code: "not_found", message: "Organization not found" } });
    if (url.pathname === "/v1/cloud-v2/github/connection" && method === "POST") {
      if (body.expected !== "a".repeat(64)) return this.reply(409, { error: { code: "github_connection_changed" } });
      if (body.action === "pat") this.patConnected = true;
      if (body.action === "disconnect" && body.method === "pat") this.patConnected = false;
      return this.reply(200, {});
    }
    if (url.pathname === "/v1/cloud-v2/github/connection") {
      const pat = this.githubIdentity || this.patConnected;
      return this.reply(200, { generation: "a".repeat(64), selectedMethod: pat ? "pat" : null,
        methods: { "github-app": { configured: false }, pat: { configured: pat } }, appAvailable: true, installUrl: null });
    }
    if (parts[1] === "organizations" && parts[3] === "agent-connections" && method === "GET")
      return this.reply(200, { credentials: [], connections: ["claude", "codex", "cursor"].map((provider, index) => {
        const selected = this.agentSelections.get(provider), foreign = this.agentConnections.includes(provider) && !selected;
        const credentialId = selected ? selected.credentialId : foreign ? `00000000-0000-4000-8000-00000000000${index + 1}` : null;
        const connected = foreign || (!!credentialId && this.agentCredentials.get(credentialId)?.revoked === false);
        return { provider, revision: selected?.revision ?? (foreign ? 1 : 0), credentialId, connected };
      }) });
    // Settings' agent routes (agent-credential-routes.ts): a credential, its organization selection, its removal and revoke.
    if (parts[1] === "organizations" && parts[3] === "agent-connections" && parts[4] === "accounts" && method === "DELETE") {
      for (const [provider, selected] of this.agentSelections)
        if (selected.credentialId === parts[5]) this.agentSelections.set(provider, { credentialId: null, revision: selected.revision + 1 });
      return this.reply(200, { removed: true });
    }
    if (parts[1] === "organizations" && parts[3] === "agent-connections" && parts[4] && method === "PUT") {
      const provider = parts[4], current = this.agentSelections.get(provider)?.revision ?? (this.agentConnections.includes(provider) ? 1 : 0);
      if (body.expectedRevision !== current) return this.reply(409, { error: { code: "agent_connection_conflict" } });
      const credential = this.agentCredentials.get(String(body.credentialId));
      if (!credential || credential.revoked || !credential.kind.startsWith(`${provider}-`)) return this.reply(404, { error: { code: "agent_credential_unavailable" } });
      if (body.credentialRevision !== credential.revision || !Array.isArray(body.models) || !body.models.length) return this.reply(409, { error: { code: "agent_credential_conflict" } });
      this.agentSelections.set(provider, { credentialId: String(body.credentialId), revision: current + 1 });
      return this.reply(200, { revision: current + 1, replayed: false });
    }
    if (parts[1] === "cloud-agent-credentials") {
      if (!parts[2] && method === "GET") return this.reply(200, { credentials: [...this.agentCredentials].filter(([, row]) => !row.revoked)
        .map(([id, row]) => ({ id, kind: row.kind, displayName: "x", revision: row.revision, revoked: false, connectionMethod: "api" })) });
      const id = parts[2]!;
      if (method === "PUT") {
        if (this.proGrant !== null && !this.pro()) return this.reply(403, { error: { code: "pro_required" } });
        const material = body.material as Record<string, unknown> | undefined;
        const value = material?.accessToken ?? material?.apiKey;
        if (typeof material?.kind !== "string" || typeof value !== "string" || body.expectedRevision !== 0) return this.reply(422, { error: { code: "invalid_agent_credential_request" } });
        this.agentMaterialValues.push(value);
        this.agentCredentials.set(id, { kind: material.kind, revoked: false, revision: 1, organizationId: typeof body.organizationId === "string" ? body.organizationId : null });
        return this.reply(200, { credential: { id, kind: material.kind, displayName: String(body.displayName), revision: 1, revoked: false, connectionMethod: "api" } });
      }
      if (method === "DELETE") {
        const row = this.agentCredentials.get(id);
        if (!row) return this.reply(404, { error: { code: "agent_credential_unavailable" } });
        row.revoked = true; return this.reply(200, { revoked: true });
      }
    }
    if (url.pathname === "/v1/me") return this.reply(200, { user: { id: this.userId }, capabilities: { pro: this.pro() },
      organizations: [{ id: this.organizationId, slug: "user-2", name: "Zeros User-2", role: "owner", isPersonal: true, seat: this.pro() ? "pro" : "free" }] });
    if (parts[2] === "organizations" && parts[4] === "cloud-projects") {
      const id = parts[5];
      if (!id && method === "GET") return this.reply(200, { canCreateOrganization: true, personalAllowed: false,
        projects: [...this.projects.values()].map(project => this.project(project)) });
      if (!id && method === "POST") {
        const project: Project = { id: randomUUID(), name: String(body.name), organizationId: this.organizationId,
          repositories: (body.repositories as { repository: string }[]).map(row => row.repository), machine: "",
          submodules: (body.repositories as { fetchSubmodules?: boolean }[]).some(row => row.fetchSubmodules === true) };
        // A project's copy needs a base: made sure of first (composition.ts changed → ensureBase).
        this.ensureBase();
        project.machine = this.machine(`copy ${project.name}`);
        project.copyFailed = this.copyFailures.shift() ?? null;
        this.machines.get(project.machine)!.state = "stopped";
        this.projects.set(project.id, project);
        return this.reply(201, { project: this.project(project) });
      }
      const project = id ? this.projects.get(id) : undefined;
      if (!project) return this.reply(404, { error: { code: "not_found" } });
      if (parts[6] === "ready-copy" && parts[7] === "retry" && method === "POST") {
        this.copyRetries++; project.copyFailed = this.copyFailures.shift() ?? null;
        return this.reply(202, { ok: true });
      }
      if (parts[6] === "ready-copy") return this.reply(200, { status: project.copyFailed
        ? { state: "failed", failure: { reason: project.copyFailed, repository: null, step: "stop", detail: null, failures: 1, nextRetryAt: null } } : { state: "ready" } });
      if (method === "DELETE") { this.machines.get(project.machine)!.state = "deleted"; this.projects.delete(project.id); return this.reply(200, { ok: true }); }
      return this.reply(200, { project: this.project(project) });
    }
    if (parts[2] === "organizations" && parts[4] === "environment") {
      // Its routes resolve the repository through the caller's GitHub sign-in in the organization.
      if (!this.githubIdentity && !this.patConnected) return this.reply(409, { error: { code: "github_connection_required" } });
      const environment = this.environments.get(parts[5]!) ?? { revision: 0, files: new Map<string, string>() };
      if (method === "PATCH") {
        if (body.expectedRevision !== environment.revision) return this.reply(409, { error: { code: "cloud_environment_conflict" } });
        if (body.clear) environment.files.clear();
        for (const file of (body.files ?? []) as { path: string; content: string }[]) environment.files.set(file.path, file.content);
        environment.revision++;
        this.environments.set(parts[5]!, environment);
      }
      return this.reply(200, { environment: { repositoryId: parts[5], revision: environment.revision, versionId: null, updatedAt: null, variables: [],
        files: [...environment.files.keys()].map(path => ({ path, bytes: 1 })) } });
    }
    if (parts[2] === "organizations" && parts[4] === "computer" && parts[5] === "install-script") {
      if (method === "PUT") {
        if (body.revision !== this.recipeRevision) return this.reply(409, { error: { code: "computer_recipe_changed" } });
        this.installScript = (body.installScript as string | null) ?? null; this.recipeRevision++;
      }
      return this.reply(200, { installScript: this.installScript, recipeRevision: this.recipeRevision });
    }
    if (parts[2] === "organizations" && parts[4] === "computer") {
      if (method === "POST" && parts[5] === "builds") {
        const id = randomUUID(), snapshot = `zeros-alpha-${this.computer.builds.length + 1}`, builderSandboxId = this.machine("builder");
        // The fake builds at once: the builder machine is gone, the snapshot saved, the build live; the replaced
        // build's snapshot is cleaned up, as the product's cleanup does once nobody is creating from it.
        this.machines.get(builderSandboxId)!.state = "deleted"; this.snapshots.add(snapshot);
        for (const old of this.computer.builds) if (old.snapshot) { this.snapshots.delete(old.snapshot); old.snapshot = null; }
        this.computer.builds.unshift({ id, state: "succeeded", snapshot, builderSandboxId, createdAt: this.now }); this.computer.active = id;
        return this.reply(202, { build: { id, state: "queued" } });
      }
      return this.reply(200, { activeBuildId: this.computer.active, snapshotName: null, recipeRevision: 0,
        builds: this.computer.builds.map(build => ({ id: build.id, state: build.state, builderSandboxId: build.builderSandboxId })),
        ...(this.automaticBase ? { base: this.baseView() } : {}) });
    }
    if (parts[2] === "organizations" && parts[4] === "github") return this.reply(200, { organization: [{ accountLogin: "Withso", state: "active" }], personal: [] });
    if (parts[2] === "workspaces" && parts[3] === "by-number") return this.reply(404, { error: { code: "not_found" } });
    if (url.pathname === "/v1/cloud-v2/workspaces" && method === "GET")
      return this.reply(200, { workspaces: [...this.workspaces.values()].filter(row => row.state !== "deleted").map(row => this.document(row)) });
    if (url.pathname === "/v1/cloud-v2/workspaces" && method === "POST") {
      const project = this.projects.get(String(body.projectId));
      if (!project) return this.reply(404);
      const base = this.ensureBase();
      const id = randomUUID(), branch = String(body.branch);
      const repositories = project.repositories.length > 1
        ? project.repositories.map(repository => ({ repository, checkoutPath: `/home/user/p/${repository.split("/")[1]}`, branch, baseBranch: "main" })) : undefined;
      const row: Workspace = { id, name: String(body.name), organizationId: this.organizationId, state: "running", branch,
        boatSandboxId: this.machine(`${this.machines.get(project.machine)!.name} fork`), projectId: project.id, archivedAt: null,
        activeAt: new Date(this.now).toISOString(), updatedAt: new Date(this.now).toISOString(), keep: false, ...(repositories ? { repositories } : {}),
        files: new Map(), seeded: new Map(), commits: new Map(), pushed: new Set(), stoppedDays: null, backup: false, wakes: 0, scrub: null, machineGone: false };
      for (const [index, repository] of project.repositories.entries()) {
        const seeded = this.environments.get(this.repositoryId(repository));
        const folder = repositories?.[index]?.checkoutPath ?? "/home/user/p";
        for (const [file, content] of seeded?.files ?? []) { row.files.set(`${folder}/${file}`, content); row.seeded.set(`${folder}/${file}`, content); }
      }
      row.computerBuildId = this.computer.active;
      if (base?.state === "building") {
        // It waits for the base being prepared: no machine yet.
        this.machines.get(row.boatSandboxId)!.state = "deleted";
        Object.assign(row, { state: "creating", boatSandboxId: "", waitingFor: base.id, computerBuildId: base.id, createdAtMs: this.now });
      }
      this.workspaces.set(id, row); if (!this.forkFallback) this.forks.add(id);
      return this.reply(201, { workspace: this.document(row) });
    }
    if (parts[2] === "workspaces" && parts[3]) {
      const row = this.workspaces.get(parts[3]);
      if (!row || row.state === "deleted" && method !== "GET") return this.reply(404, { error: { code: "not_found" } });
      const action = parts[4];
      if (row.state !== "deleted" && !this.pro() && this.proGrant !== null) return this.reply(403, { error: { code: "pro_required" } });
      if (action === "connect") {
        // routes.ts: a workspace of several repositories (it has a folder) connects only for a client declaring them.
        const features = (headers["X-Zeros-Client-Features"] ?? "").split(",").map(value => value.trim());
        if ((row.repositories?.length ?? 0) > 1 && !features.includes(WORKSPACE_REPOSITORIES_FEATURE)) return this.reply(409, { error: { code: "client_update_required" } });
        if (row.state === "failed" || row.state === "deleting") return this.reply(409, { error: { code: "workspace_unavailable" } });
        if (row.state !== "running") return this.reply(409, { error: { code: "cloud_workspace_not_running" } });
        return this.reply(200, { url: "wss://alpha.test/x", protocols: ["zeros.cloud.v2", "ticket.x"] });
      }
      if (!action && method === "GET") return row.state === "deleted" ? this.reply(404) : this.reply(200, { workspace: this.document(row) });
      if (!action && method === "DELETE") { row.state = "deleted"; const machine = this.machines.get(row.boatSandboxId); if (machine) machine.state = "deleted"; return this.reply(202, { workspace: this.document(row) }); }
      if (action === "stop") {
        row.state = "stopped"; row.stoppedDays = 0; row.stopGeneration = (row.stopGeneration ?? 0) + 1;
        // Dirty: an unpushed commit, or an ignored .env file that is not exactly what the environment seeded.
        row.probe = [...row.commits.values()].some(list => list.length) || [...row.files].some(([file, content]) => file.endsWith(".env") && row.seeded.get(file) !== content)
          ? "dirty" : "clean";
        this.machines.get(row.boatSandboxId)!.state = "stopped";
        return this.reply(202, { workspace: this.document(row) });
      }
      if (action === "archive") { row.state = "stopped"; row.archivedAt = new Date(this.now).toISOString(); row.archiveReason = "manual"; row.archivedAtDays = row.stoppedDays ?? 0; return this.reply(202, { workspace: this.document(row) }); }
      if (action === "start") {
        if (this.machines.get(row.boatSandboxId)?.state === "deleted") {
          row.boatSandboxId = this.machine(`${row.name} restored`);
          // The bug the rehearsal looks for: a clean rebuild that keeps the workspace's replaced build.
          if (!this.staleRestorePin) row.computerBuildId = this.computer.active;
          if (!row.backup) { row.files = new Map(); row.commits = new Map(); }
          // A dirty stop whose backup is an earlier stop's: restored from that one, and the open notes lost work.
          if (row.probe === "dirty" && row.backupGeneration !== (row.stopGeneration ?? 0)) row.lostWork = true;
        }
        row.state = "running"; row.archivedAt = null; row.stoppedDays = null; row.scrub = null;
        this.machines.get(row.boatSandboxId)!.state = "running";
        return this.reply(202, { workspace: this.document(row) });
      }
      if (action === "keep") {
        if (method === "PUT" && row.archivedAt) return this.reply(409, { error: { code: "keep_refused_archived" } });
        row.keep = method === "PUT"; return this.reply(200, { workspace: this.document(row) });
      }
      if (action === "github") return this.github(row, body);
    }
    return this.reply(404, { error: { code: "not_found" } });
  }
  private project(project: Project) {
    return { id: project.id, name: project.name, level: "organization", repositories: project.repositories.map(repository => ({ repository, repositoryId: this.repositoryId(repository) })), readyCopy: "ready" };
  }
  repositoryId(repository: string): string { return String(1000 + [...this.repositories.keys()].indexOf(repository.toLowerCase())); }
  private github(row: Workspace, body: Record<string, unknown>): ApiReply {
    const repository = String(body.repository ?? row.repositories?.[0]?.repository ?? [...this.projects.get(row.projectId!)!.repositories][0]);
    const repo = this.repositories.get(repository.toLowerCase())!;
    const authority = { connectionGeneration: "1", repositoryId: "1", repository, branch: row.branch, baseBranch: "main", contextRevision: "1" };
    const params = body.params as Record<string, unknown>;
    if (body.op === "gh.prSync") return this.reply(200, { authority, result: null });
    if (body.op === "gh.prCreate") {
      if (!repo.branches.has(row.branch)) return this.reply(409, { error: { code: "github_checkout_unavailable" } });
      const number = this.nextPull++;
      repo.pulls.set(number, { head: row.branch, open: true });
      this.published.push(String(params.title), String(params.body));
      return this.reply(200, { authority, result: { number, headSha: "a".repeat(40), baseSha: "b".repeat(40), state: "draft", headBranch: row.branch } });
    }
    if (body.op === "gh.prUpdate") {
      const pull = repo.pulls.get(Number(params.prNumber))!; pull.open = params.state !== "closed";
      for (const key of ["title", "body"] as const) if (typeof params[key] === "string") this.published.push(params[key] as string);
      return this.reply(200, { authority, result: { number: params.prNumber, headSha: "a".repeat(40), baseSha: "b".repeat(40), state: pull.open ? "draft" : "closed", headBranch: pull.head } });
    }
    return this.reply(400);
  }

  /** As the live bridge: a connect through the API (connectWorkspace), then the socket. */
  async bridge(workspaceId: string): Promise<Bridge> {
    await connectWorkspace(this.api(), workspaceId, "connect");
    return this.counted(() => {
      const row = this.workspaces.get(workspaceId);
      if (!row || row.state !== "running") throw new RehearsalFailure("connect", "http_409");
      const frames: { type: string; [key: string]: unknown }[] = [], sessions = new Map<string, string>();
      const repositoryOf = (params: Record<string, unknown>) => String(params.repository ?? row.repositories?.[0]?.repository ?? this.projects.get(row.projectId!)!.repositories[0]);
      // As the worker (scope.ts repositoryFor, worker.ts workspaceFor): a named repository's request goes to that repository's
      // service, rooted at its checkout, whose scope holds no other folder; any other goes to the first repository's (or the
      // only one's), rooted at its checkout. A path outside the serving checkout answers kind error.
      const fileAt = (params: Record<string, unknown>): string | null => {
        const checkouts = row.repositories ?? [], named = typeof params.repository === "string"
          ? checkouts.find(entry => entry.repository.toLowerCase() === String(params.repository).toLowerCase()) : undefined;
        if (typeof params.repository === "string" && checkouts.length > 1 && !named) throw new RehearsalFailure("file", "reply_WORKSPACE_ERROR");
        const base = named?.checkoutPath ?? checkouts[0]?.checkoutPath ?? "/home/user/p";
        if (named && named !== checkouts[0] && params.cwd !== undefined && params.cwd !== base) throw new RehearsalFailure("file", "reply_WORKSPACE_ERROR");
        const path = String(params.path);
        const target = path.startsWith("/") ? path : `${base}/${path}`;
        return target.startsWith(`${base}/`) ? target : null;
      };
      const op = (name: string, params: Record<string, unknown> = {}): unknown => {
        switch (name) {
          case "workspace.list": return { workspaces: [{ id: row.id, path: "/home/user/p" }] };
          case "file.write": {
            const target = fileAt(params);
            if (!target) return { kind: "error", path: String(params.path), bytes: 0, error: "The file could not be written within this workspace." };
            row.files.set(target, String(params.content)); return { kind: "success", path: params.path, bytes: String(params.content).length };
          }
          case "file.read": {
            const target = fileAt(params);
            return target && row.files.has(target) ? { kind: "text", path: params.path, content: row.files.get(target) }
              : { kind: "error", path: String(params.path), bytes: 0, error: "The file could not be read within this workspace." };
          }
          case "git.commit": {
            const repo = repositoryOf(params); row.commits.set(repo, [...row.commits.get(repo) ?? [], String(params.message)]);
            const key = `${row.id}:${repo}`;
            this.unpushed.set(key, [...this.unpushed.get(key) ?? [], String(params.message),
              ...((params.files ?? []) as string[]).flatMap(file => { const at = file.startsWith("/") ? file : fileAt({ ...params, path: file }) ?? file;
                return [file.split("/").at(-1)!, row.files.get(at) ?? ""]; })]);
            return {};
          }
          case "git.push": {
            const repo = repositoryOf(params), key = `${row.id}:${repo}`;
            this.repositories.get(repo.toLowerCase())!.branches.add(row.branch); row.commits.set(repo, []);
            this.published.push(row.branch, ...this.unpushed.get(key) ?? []); this.unpushed.delete(key);
            return {};
          }
          case "chats.upsert": return {};
          case "messages.window": return { messages: [{ msgId: "1", kind: "text", payload: JSON.stringify({ role: "agent", text: "ok." }) }] };
          case "turns.list": return { turns: this.turns.map(turn => ({ ...turn })) };
          case "turns.reset": {
            const from = this.turns.find(turn => turn.turnId === params.turnId)!;
            for (const turn of this.turns.filter(candidate => candidate.chatId === from.chatId && candidate.startedAt >= from.startedAt))
              for (const file of turn.files) row.files.delete(file);
            return { applied: [] };
          }
          default: throw new RehearsalFailure(name, "unsupported");
        }
      };
      return {
        op: (name, params) => this.counted(() => op(name, params)),
        request: (type, fields) => this.counted(() => {
          if (type === "AGENT_NEW_SESSION" && this.sessionReply) return this.sessionReply;
          if (type === "AGENT_NEW_SESSION") { const sessionId = randomUUID(); sessions.set(sessionId, String(fields.chatId)); return { type: "AGENT_SESSION_CREATED", session: { sessionId } }; }
          if (type === "PTY_CREATE") return { type: "PTY_CREATED", sessionId: String(fields.sessionId), cwd: String(fields.cwd) };
          if (type === "AGENT_PROMPT") {
            const text = String((fields.prompt as { text: string }[])[0]!.text), file = /Create the file (\S+) containing/.exec(text)?.[1];
            if (file) row.files.set(file, "x\n");
            this.turns.push({ chatId: sessions.get(String(fields.sessionId)) ?? "unknown", turnId: randomUUID(), startedAt: this.now + this.turns.length, files: file ? [file] : [] });
            return { type: "AGENT_PROMPT_COMPLETE" };
          }
          throw new RehearsalFailure(type.toLowerCase(), "unsupported");
        }),
        send: (type, fields) => {
          if (type === "PTY_WRITE") frames.push({ type: "PTY_DATA", sessionId: fields.sessionId, data: this.pty(row, String(fields.data)) });
          return randomUUID();
        },
        frames: () => frames,
        close: () => undefined,
      };
    });
  }
  /** The few shell commands the stages run, by shape. */
  private pty(row: Workspace, data: string): string {
    const begin = /printf '%s\\n' '(zr-begin-[0-9a-f]+)'/.exec(data)?.[1], end = /'(zr-end-[0-9a-f]+)'/.exec(data)?.[1];
    if (!begin || !end) {
      const marker = /printf '%s:%s\\n' '([^']+)'/.exec(data)?.[1];
      return `${marker}:${row.branch}\r\n`;
    }
    let output = "";
    const committed = /commit -q -m '([^']+)'/.exec(data)?.[1];
    if (committed) {
      // The stage commits in its second repository (R2).
      const repository = row.repositories?.[1]?.repository ?? "";
      row.commits.set(repository, [...row.commits.get(repository) ?? [], committed]);
      const untracked = /> '([^']+untracked\.txt)'/.exec(data)?.[1] ?? "";
      row.files.set(`${row.repositories!.find(entry => entry.repository === repository)!.checkoutPath}/${untracked}`, `${untracked.replace("untracked.txt", "untracked")}\n`);
    }
    const ignored = /printf '%s\\n' '([^']+person-bytes)' (>>?) '([^']+)'/.exec(data);
    if (ignored) {
      const file = `${row.repositories![0]!.checkoutPath}/${ignored[3]}`;
      row.files.set(file, `${ignored[2] === ">>" ? row.files.get(file) ?? "" : ""}${ignored[1]}\n`);
    }
    if (data.includes("git log")) output = [...row.commits.values()].flat().reverse().join("\r\n");
    if (data.includes("git submodule status")) output = [` ${"7fd1a60b01f91b314f59955a4e4d4e80d8edf11d"} vendor/hello (heads/master)`, ` ${"b".repeat(40)} vendor/private (heads/main)`].join("\r\n");
    return `${begin}\r\n${output}\r\n${end} 0\r\n`;
  }

  ports(overrides: Partial<Ports> = {}): Ports {
    return {
      release: () => this.counted(() => true), api: this.api(), bridge: id => this.bridge(id),
      boat: {
        inspect: id => this.counted(() => { const row = this.machines.get(id); return row && row.state !== "deleted" ? { ...row } : null; }),
        snapshot: id => this.counted(() => {
          const row = this.machines.get(id);
          if (!row || row.state === "deleted") return null;
          const created = new Date(this.now - 120_000).toISOString();
          return { createdAt: created, stoppedAt: row.state === "stopped" ? new Date(this.now - 60_000).toISOString() : null, hydrated: true,
            lastSnapshotStatus: this.snapshotStatus, lastSnapshotAttemptAt: new Date(this.now - 70_000).toISOString(), snapshotCompletedAt: new Date(this.now - 60_000).toISOString() };
        }),
        delete: id => this.counted(() => { const row = this.machines.get(id); if (row) row.state = "deleted"; }),
        snapshotExists: name => this.counted(() => this.snapshots.has(name)),
        deleteSnapshot: name => this.counted(() => { this.snapshots.delete(name); }),
      },
      storage: {
        keys: id => this.counted(() => [...this.objects].filter(key => key.startsWith(`cloud-v2/checkpoints/${id}/`))),
        delete: key => this.counted(() => { this.objects.delete(key); }),
      },
      github: {
        repositoryExists: name => this.counted(() => this.repositories.has(name.toLowerCase())),
        branches: (name, prefix) => this.counted(() => [...this.repositories.get(name.toLowerCase())?.branches ?? []].filter(branch => branch.startsWith(prefix))),
        deleteBranch: (name, branch) => this.counted(() => { this.repositories.get(name.toLowerCase())?.branches.delete(branch); }),
        openPulls: (name, prefix) => this.counted(() => [...this.repositories.get(name.toLowerCase())?.pulls ?? []]
          .filter(([, pull]) => pull.open && pull.head.startsWith(prefix)).map(([number]) => number)),
        closePull: (name, number) => this.counted(() => { const pull = this.repositories.get(name.toLowerCase())?.pulls.get(number); if (pull) pull.open = false; }),
        ignores: () => this.counted(() => this.ignoresEnv),
      },
      database: {
        read: (text, values) => this.counted(() => { this.tick(); this.readTexts.add(text); return this.sql(text, values ?? []).rows; }),
        transaction: work => this.counted(() => { this.transactions++; return work((text, values) => Promise.resolve(this.sql(text, values ?? []))); }),
        close: () => Promise.resolve(),
      },
      clock: { now: () => this.now, sleep: async ms => { this.now += ms; this.tick(); } },
      pro: this.proPort(), other: this.otherApi(),
      githubSignIn: { connect: (organizationId, expected) => this.counted(async () => {
        const reply = this.route("POST", "/v1/cloud-v2/github/connection", { organizationId, expected, action: "pat", token: "synthetic" });
        if (reply.status !== 200) throw new RehearsalFailure("github_sign_in_connect", `http_${reply.status}`);
      }) },
      ...overrides,
    };
  }

  /** Every statement read through the read role (rehearsal-reads.ts lists them all, for the read-role test). */
  readonly readTexts = new Set<string>();

  /** The statements the rehearsal sends, recognized by shape. */
  sql(text: string, values: unknown[]): Awaited<ReturnType<Query>> {
    const rows = (list: Record<string, unknown>[]) => ({ rows: list, rowCount: list.length });
    const ids = (values[0] ?? []) as string[];
    // Stage D: the copy's record of its submodules, and a workspace's submodule rows (a token sign-in's create).
    if (text.startsWith("SELECT result FROM cloud_v2_ready_copies")) {
      const project = this.projects.get(String(values[0]));
      return rows(project ? [{ result: project.repositories.map(repository => ({ repository,
        ...(project.submodules ? { submodules: [{ path: "vendor/hello", fetched: true, public: true }, { path: "vendor/private", fetched: true, public: true }] } : {}) })) }] : []);
    }
    if (text.includes("FROM cloud_v2_workspace_submodules")) {
      const project = this.projects.get(String(this.workspaces.get(String(values[0]))?.projectId));
      return rows(project?.submodules ? [{ path: "vendor/hello", status: "fetch", public: true }, { path: "vendor/private", status: "fetch", public: true }] : []);
    }
    // The run's bases (#1260): by organization, automatic, created after the run started; or recorded ids.
    const runBase = (build: Build, idsAt: number, startAt: number) =>
      ((values[idsAt] ?? []) as string[]).includes(build.id) || (build.automatic === true && (build.createdAt ?? 0) >= Date.parse(String(values[startAt])));
    if (text.startsWith("SELECT id::text AS id, base_shared FROM cloud_v2_computer_builds")) {
      return rows(this.computer.builds.filter(build => build.automatic && (build.createdAt ?? 0) >= Date.parse(String(values[1]))).reverse()
        .map(build => ({ id: build.id, base_shared: build.shared === true })));
    }
    if (text.includes("FOR UPDATE OF c, b")) {
      const live = this.computer.builds.find(build => build.id === this.computer.active);
      return rows(live && runBase(live, 1, 2) ? [{ id: live.id, snapshot_id: live.snapshot, base_shared: live.shared === true }] : []);
    }
    if (text.includes("/* run bases */")) return rows(this.computer.builds.filter(build => runBase(build, 1, 2))
      .map(build => ({ active: this.computer.active === build.id, snapshot_id: build.snapshot, base_shared: build.shared === true })));
    if (text.includes("waiting_for_base_at IS NOT NULL AS waiting")) {
      const row = this.workspaces.get(String(values[0]));
      return rows(row ? [{ waiting: row.waitingFor !== undefined, build: row.computerBuildId ?? null }] : []);
    }
    if (text.startsWith("SELECT computer_build_id::text AS build FROM cloud_v2_workspaces WHERE id = $1::uuid")) {
      const row = this.workspaces.get(String(values[0]));
      return rows(row ? [{ build: row.computerBuildId ?? null }] : []);
    }
    if (text.includes("snapshot_deleted_at IS NOT NULL AS gone")) {
      const build = this.computer.builds.find(row => row.id === values[0]);
      return rows(build ? [{ gone: build.snapshot === null }] : []);
    }
    if (text.includes("computer_build_id::text AS build")) return rows(ids.map(id => ({ id, build: this.workspaces.get(id)?.computerBuildId ?? null })));
    if (text.includes("FROM cloud_v2_computer_builds b")) {
      const build = this.computer.builds.find(row => row.id === values[0]);
      if (!build) return rows([]);
      return text.includes("AS active,") ? rows([{ active: this.computer.active === build.id, snapshot_id: build.snapshot }])
        : rows([{ snapshot_id: build.snapshot, active: this.computer.active }]);
    }
    if (text.startsWith("UPDATE cloud_v2_computers")) {
      const changed = this.computer.active === values[1] ? 1 : 0; if (changed) this.computer.active = null;
      return { rows: [], rowCount: changed };
    }
    if (text.startsWith("UPDATE cloud_v2_computer_builds")) {
      const build = this.computer.builds.find(row => row.id === values[0] && row.snapshot === values[2]);
      if (build) build.snapshot = null;
      return { rows: [], rowCount: build ? 1 : 0 };
    }
    if (text.startsWith("SELECT state FROM cloud_v2_workspaces")) return rows([{ state: this.workspaces.get(String(values[0]))?.state ?? null }]);
    if (text.includes("FROM cloud_v2_ready_copies")) return rows([...this.projects.values()].filter(project => project.id === values[0]).map(project => ({ machine_id: project.machine })));
    if (text.includes("AS distrusted")) return rows(this.forks.has(String(values[0])) ? [{ distrusted: this.copyDistrusted, archive: this.copyArchive }] : []);
    if (text.includes("FROM cloud_v2_ready_copy_forks")) return rows([{ forks: this.forks.has(String(values[0])) ? 1 : 0 }]);
    if (text.includes("worker_off_unverified_at IS NULL AS worker_off")) return rows(ids.map(id => ({ id, backup_probe: this.workspaces.get(id)?.probe ?? null,
      current_probe: true, worker_off: this.workerOff })));
    if (text.includes("AS fork_gone")) {
      const row = this.workspaces.get(String(values[0])), backup = row?.backup === true;
      return rows([{ forks: backup ? 1 : 0, backed_up: backup && row!.backupGeneration === (row!.stopGeneration ?? 0), fork_gone: true }]);
    }
    if (text.includes("kind = 'wake'")) return rows([{ wakes: ids.reduce((sum, id) => sum + (this.workspaces.get(id)?.wakes ? 1 : 0), 0) }]);
    if (text.includes("archive_scrub FROM")) return rows(ids.map(id => ({ id, archive_scrub: this.workspaces.get(id)?.scrub ?? null })));
    if (text.includes("information_schema.tables")) return rows([{ present: this.s4 ? 1 : 0 }]);
    // The fake keeps one timestamp; the real schema's full list is covered by clock.integration.test.ts.
    if (text.includes("information_schema.columns")) return rows([{ column_name: "stopped_at" }]);
    if (text.includes("platform_owner")) return rows([{ id: "aaaaaaaa-0000-0000-0000-000000000000" }]);
    if (text.includes("left(name, length($1))")) {
      const prefix = String(values[0]);
      return rows([{ workspaces: [...this.workspaces.values()].filter(row => row.name.startsWith(prefix) && row.state !== "deleted").length,
        projects: [...this.projects.values()].filter(row => row.name.startsWith(prefix)).length }]);
    }
    if (text.includes("FOR UPDATE")) return rows(ids.flatMap(id => { const row = this.workspaces.get(id); return row && row.state !== "deleted" ? [{ id, name: row.name, org_id: row.organizationId }] : []; }));
    if (text.startsWith("SELECT id::text AS id, ((extract")) return rows(ids.map(id => ({ id, stopped_at: String(BigInt(this.stamp(id)) * 1000n) })));
    if (text.startsWith("UPDATE cloud_v2_workspaces")) {
      const days = Number(values[1]) / 86_400;
      this.shifts.push({ ids, days });
      for (const id of ids) { const row = this.workspaces.get(id)!; if (row.stoppedDays !== null) row.stoppedDays += days; this.shifted.set(id, (this.shifted.get(id) ?? 0) + Number(values[1])); }
      return { rows: [], rowCount: ids.length };
    }
    if (text.startsWith("UPDATE cloud_v2_maintenance_wakes")) return { rows: [], rowCount: 0 };
    throw new RehearsalFailure("fake_sql", "unknown");
  }
  private readonly shifted = new Map<string, number>();
  /** A stopped_at in milliseconds that moves back with every shift, so shiftClock's read-back is exact. */
  private stamp(id: string): number { return 1_600_000_000_000 - (this.shifted.get(id) ?? 0) * 1000; }
}
