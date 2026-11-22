// An in-memory Alpha for the rehearsal's unit tests: the API routes, bridge ops, Boat, R2, GitHub and database reads
// the stages use, with a retention lifecycle that advances when a test shifts a workspace's clock. Every port call is
// counted so a test can fail the n-th one, before or after its effect.
import { randomUUID } from "node:crypto";
import { RehearsalFailure, type Api, type ApiReply, type Bridge, type Ports, type Query } from "../rehearsal/contract.js";

type Workspace = {
  id: string; name: string; organizationId: string; state: string; branch: string; boatSandboxId: string; projectId?: string;
  archivedAt: string | null; activeAt: string; updatedAt: string; keep: boolean; archiveReason?: string;
  repositories?: { repository: string; checkoutPath: string; branch: string; baseBranch: string }[];
  files: Map<string, string>; commits: Map<string, string[]>; pushed: Set<string>;
  // Retention, in days since the stop.
  stoppedDays: number | null; archivedAtDays?: number; probe?: "clean" | "dirty"; backup: boolean; wakes: number; scrub: string | null; machineGone: boolean; lostWork?: boolean;
};
type Project = { id: string; name: string; organizationId: string; repositories: string[]; machine: string };
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
  readonly writes: string[] = [];
  readonly shifts: { ids: string[]; days: number }[] = [];
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
    return { id: row.id, name: row.name, organizationId: row.organizationId, state: row.state, branch: row.branch, boatSandboxId: row.boatSandboxId,
      archivedAt: row.archivedAt, activeAt: row.activeAt, updatedAt: row.updatedAt, keep: row.keep, ...(row.projectId ? { projectId: row.projectId } : {}),
      ...(row.repositories ? { repositories: row.repositories } : {}), ...(archived && row.archiveReason ? { archiveReason: row.archiveReason } : {}),
      ...(archived ? { machineExpectedGoneAt: { at: new Date(this.now).toISOString(), estimate: true } } : {}),
      ...(archived && row.backup ? { backupRemovalAt: new Date(this.now).toISOString() } : {}),
      ...(this.s4 && archived ? { restores: { code: row.backup ? "backup" : "github" } } : {}),
      ...(row.lostWork ? { lostWork: { restored: "none", stoppedAt: new Date(this.now).toISOString() } } : {}) };
  }

  /** The retention lifecycle, run on every database read and clock sleep. */
  tick(): void {
    for (const row of this.workspaces.values()) {
      if (row.state !== "stopped" || row.stoppedDays === null) continue;
      if (row.probe === "dirty" && !row.backup && row.stoppedDays >= 1 / 24) { row.backup = true; this.objects.add(`cloud-v2/checkpoints/${row.id}/a.zck`); }
      if (row.archivedAt === null && row.stoppedDays >= 10 && row.wakes === 0) row.wakes = 1;
      if (row.archivedAt === null && !row.keep && row.stoppedDays >= 30) {
        row.archivedAt = new Date(this.now).toISOString(); row.archiveReason = "inactive"; row.archivedAtDays = row.stoppedDays;
      }
      // The archived wake, ten days after the archive.
      if (row.archivedAt !== null && row.scrub === null && row.stoppedDays >= (row.archivedAtDays ?? 0) + 10) { row.scrub = row.backup ? "backup" : "clean"; row.wakes++; }
      if (this.s4 && row.archivedAt !== null && row.backup && row.stoppedDays >= 61 && row.archiveReason === "manual") {
        row.backup = false; for (const key of [...this.objects]) if (key.includes(row.id)) this.objects.delete(key);
      }
    }
  }

  api(): Api {
    return { json: (method, path, body) => this.counted(() => this.route(method, path, body as Record<string, unknown> | undefined)) };
  }

  private route(method: string, path: string, body: Record<string, unknown> = {}): ApiReply {
    if (method !== "GET") this.writes.push(`${method} ${path.replace(/[0-9a-f-]{36}/g, ":id")}`);
    const url = new URL(path, "https://alpha.test"), parts = url.pathname.split("/").filter(Boolean);
    if (url.pathname === "/v1/me") return this.reply(200, { capabilities: { pro: false }, organizations: [{ id: this.organizationId, slug: "probe", name: "Probe", role: "owner" }] });
    if (parts[2] === "organizations" && parts[4] === "cloud-projects") {
      const id = parts[5];
      if (!id && method === "GET") return this.reply(200, { canCreateOrganization: true, personalAllowed: false,
        projects: [...this.projects.values()].map(project => this.project(project)) });
      if (!id && method === "POST") {
        const project: Project = { id: randomUUID(), name: String(body.name), organizationId: this.organizationId,
          repositories: (body.repositories as { repository: string }[]).map(row => row.repository), machine: "" };
        project.machine = this.machine(`copy ${project.name}`);
        this.machines.get(project.machine)!.state = "stopped";
        this.projects.set(project.id, project);
        return this.reply(201, { project: this.project(project) });
      }
      const project = id ? this.projects.get(id) : undefined;
      if (!project) return this.reply(404, { error: { code: "not_found" } });
      if (parts[6] === "ready-copy") return this.reply(200, { status: { state: "ready" } });
      if (method === "DELETE") { this.machines.get(project.machine)!.state = "deleted"; this.projects.delete(project.id); return this.reply(200, { ok: true }); }
      return this.reply(200, { project: this.project(project) });
    }
    if (parts[2] === "organizations" && parts[4] === "github") return this.reply(200, { organization: [{ accountLogin: "Withso", state: "active" }], personal: [] });
    if (url.pathname === "/v1/cloud-v2/workspaces" && method === "GET")
      return this.reply(200, { workspaces: [...this.workspaces.values()].filter(row => row.state !== "deleted").map(row => this.document(row)) });
    if (url.pathname === "/v1/cloud-v2/workspaces" && method === "POST") {
      const project = this.projects.get(String(body.projectId));
      if (!project) return this.reply(404);
      const id = randomUUID(), branch = String(body.branch);
      const repositories = project.repositories.length > 1
        ? project.repositories.map(repository => ({ repository, checkoutPath: `/home/user/p/${repository.split("/")[1]}`, branch, baseBranch: "main" })) : undefined;
      const row: Workspace = { id, name: String(body.name), organizationId: this.organizationId, state: "running", branch,
        boatSandboxId: this.machine(`${this.machines.get(project.machine)!.name} fork`), projectId: project.id, archivedAt: null,
        activeAt: new Date(this.now).toISOString(), updatedAt: new Date(this.now).toISOString(), keep: false, ...(repositories ? { repositories } : {}),
        files: new Map(), commits: new Map(), pushed: new Set(), stoppedDays: null, backup: false, wakes: 0, scrub: null, machineGone: false };
      this.workspaces.set(id, row); this.forks.add(id);
      return this.reply(201, { workspace: this.document(row) });
    }
    if (parts[2] === "workspaces" && parts[3]) {
      const row = this.workspaces.get(parts[3]);
      if (!row || row.state === "deleted" && method !== "GET") return this.reply(404, { error: { code: "not_found" } });
      const action = parts[4];
      if (!action && method === "GET") return row.state === "deleted" ? this.reply(404) : this.reply(200, { workspace: this.document(row) });
      if (!action && method === "DELETE") { row.state = "deleted"; this.machines.get(row.boatSandboxId)!.state = "deleted"; return this.reply(202, { workspace: this.document(row) }); }
      if (action === "stop") {
        row.state = "stopped"; row.stoppedDays = 0;
        row.probe = [...row.commits.values()].some(list => list.length) || [...row.files.keys()].some(file => file.endsWith(".env")) ? "dirty" : "clean";
        this.machines.get(row.boatSandboxId)!.state = "stopped";
        return this.reply(202, { workspace: this.document(row) });
      }
      if (action === "archive") { row.state = "stopped"; row.archivedAt = new Date(this.now).toISOString(); row.archiveReason = "manual"; row.archivedAtDays = row.stoppedDays ?? 0; return this.reply(202, { workspace: this.document(row) }); }
      if (action === "start") {
        if (this.machines.get(row.boatSandboxId)?.state === "deleted") {
          row.boatSandboxId = this.machine(`${row.name} restored`);
          if (!row.backup) { row.files = new Map(); row.commits = new Map(); }
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
    return { id: project.id, name: project.name, level: "organization", repositories: project.repositories.map(repository => ({ repository })), readyCopy: "ready" };
  }
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
      return this.reply(200, { authority, result: { number, headSha: "a".repeat(40), baseSha: "b".repeat(40), state: "draft", headBranch: row.branch } });
    }
    if (body.op === "gh.prUpdate") {
      const pull = repo.pulls.get(Number(params.prNumber))!; pull.open = params.state !== "closed";
      return this.reply(200, { authority, result: { number: params.prNumber, headSha: "a".repeat(40), baseSha: "b".repeat(40), state: pull.open ? "draft" : "closed", headBranch: pull.head } });
    }
    return this.reply(400);
  }

  bridge(workspaceId: string): Promise<Bridge> {
    return this.counted(() => {
      const row = this.workspaces.get(workspaceId);
      if (!row || row.state !== "running") throw new RehearsalFailure("connect", "http_409");
      const frames: { type: string; [key: string]: unknown }[] = [], sessions = new Map<string, string>();
      const repositoryOf = (params: Record<string, unknown>) => String(params.repository ?? row.repositories?.[0]?.repository ?? this.projects.get(row.projectId!)!.repositories[0]);
      const op = (name: string, params: Record<string, unknown> = {}): unknown => {
        switch (name) {
          case "workspace.list": return { workspaces: [{ id: row.id, path: "/home/user/p" }] };
          case "file.write": row.files.set(String(params.path), String(params.content)); return { kind: "success" };
          case "file.read": return row.files.has(String(params.path)) ? { kind: "text", content: row.files.get(String(params.path)) } : (() => { throw new RehearsalFailure("file.read", "missing"); })();
          case "git.commit": { const repo = repositoryOf(params); row.commits.set(repo, [...row.commits.get(repo) ?? [], String(params.message)]); return {}; }
          case "git.push": { const repo = repositoryOf(params); this.repositories.get(repo.toLowerCase())!.branches.add(row.branch); row.commits.set(repo, []); return {}; }
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
      const repository = row.repositories?.find(entry => data.length && entry.repository.endsWith("two"))?.repository ?? "";
      row.commits.set(repository, [...row.commits.get(repository) ?? [], committed]);
      const untracked = /> '([^']+untracked\.txt)'/.exec(data)?.[1]!;
      row.files.set(`${row.repositories!.find(entry => entry.repository === repository)!.checkoutPath}/${untracked}`, `${untracked.replace("untracked.txt", "untracked")}\n`);
    }
    const ignored = /printf '%s\\n' '([^']+person-bytes)' > '([^']+)'/.exec(data);
    if (ignored) row.files.set(`${row.repositories![0]!.checkoutPath}/${ignored[2]}`, `${ignored[1]}\n`);
    if (data.includes("git log")) output = [...row.commits.values()].flat().reverse().join("\r\n");
    return `${begin}\r\n${output}\r\n${end} 0\r\n`;
  }

  ports(overrides: Partial<Ports> = {}): Ports {
    return {
      release: () => this.counted(() => true), api: this.api(), bridge: id => this.bridge(id),
      boat: {
        inspect: id => this.counted(() => { const row = this.machines.get(id); return row && row.state !== "deleted" ? { ...row } : null; }),
        delete: id => this.counted(() => { const row = this.machines.get(id); if (row) row.state = "deleted"; }),
      },
      storage: {
        keys: id => this.counted(() => [...this.objects].filter(key => key.startsWith(`cloud-v2/checkpoints/${id}/`))),
        delete: key => this.counted(() => { this.objects.delete(key); }),
      },
      github: {
        repositoryExists: name => this.counted(() => this.repositories.has(name.toLowerCase())),
        createRepository: name => this.counted(() => { this.repositories.set(name.toLowerCase(), { branches: new Set(["main"]), pulls: new Map() }); }),
        deleteRepository: name => this.counted(() => { this.repositories.delete(name.toLowerCase()); }),
        branches: (name, prefix) => this.counted(() => [...this.repositories.get(name.toLowerCase())?.branches ?? []].filter(branch => branch.startsWith(prefix))),
        deleteBranch: (name, branch) => this.counted(() => { this.repositories.get(name.toLowerCase())?.branches.delete(branch); }),
        openPulls: (name, prefix) => this.counted(() => [...this.repositories.get(name.toLowerCase())?.pulls ?? []]
          .filter(([, pull]) => pull.open && pull.head.startsWith(prefix)).map(([number]) => number)),
        closePull: (name, number) => this.counted(() => { const pull = this.repositories.get(name.toLowerCase())?.pulls.get(number); if (pull) pull.open = false; }),
      },
      database: {
        read: (text, values) => this.counted(() => { this.tick(); return this.sql(text, values ?? []).rows; }),
        transaction: work => this.counted(() => work((text, values) => Promise.resolve(this.sql(text, values ?? [])))),
        close: () => Promise.resolve(),
      },
      clock: { now: () => this.now, sleep: async ms => { this.now += ms; this.tick(); } },
      ...overrides,
    };
  }

  /** The statements the rehearsal sends, recognized by shape. */
  sql(text: string, values: unknown[]): Awaited<ReturnType<Query>> {
    const rows = (list: Record<string, unknown>[]) => ({ rows: list, rowCount: list.length });
    const ids = (values[0] ?? []) as string[];
    if (text.includes("FROM cloud_v2_ready_copies")) return rows([...this.projects.values()].filter(project => project.id === values[0]).map(project => ({ machine_id: project.machine })));
    if (text.includes("FROM cloud_v2_ready_copy_forks")) return rows([{ forks: this.forks.has(String(values[0])) ? 1 : 0 }]);
    if (text.includes("backup_probe FROM")) return rows(ids.map(id => ({ id, backup_probe: this.workspaces.get(id)?.probe ?? null })));
    if (text.includes("kind = 'backup_fork'")) return rows([{ forks: this.workspaces.get(String(values[0]))?.backup ? 1 : 0 }]);
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
