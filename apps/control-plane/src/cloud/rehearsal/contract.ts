// The live Alpha rehearsal's contract: the ports a stage uses (each a live adapter or a test fake), its state, and its
// closed failure codes. Nothing here prints, and nothing here holds a credential.

/** Why a step failed: a closed class, never a body, URL or message (http_503, timeout, schema:<path>, state_failed:<code>). */
export class RehearsalFailure extends Error {
  readonly code: string;
  constructor(readonly step: string, code = "failed") {
    const step_ = /^[a-z0-9_.:-]{1,64}$/.test(step) ? step : "step";
    const closed = /^[A-Za-z0-9_.:-]{1,80}$/.test(code) ? code : "other";
    super(`${step_} ${closed}`);
    this.step = step_; this.code = closed;
  }
}

export const STAGES = ["provision", "projects", "personal", "retention", "submodules"] as const;
export type StageName = (typeof STAGES)[number];
/** The control-plane switch each stage needs. The control plane does not report switches: the operator declares them. */
export const STAGE_SWITCH: Record<StageName, Switch | null> = {
  provision: null, projects: "projects", personal: "personal", retention: "retention", submodules: "projects",
};
export type Switch = "projects" | "personal" | "retention";

export type ApiReply = { status: number; body: unknown };
/** The Alpha control plane's HTTP API as one test account. Never throws on an HTTP status; a network failure throws. */
export interface Api {
  json(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown, headers?: Record<string, string>): Promise<ApiReply>;
}
/** A workspace's bridge (the desktop's WebSocket), as gate0 drives it. */
export interface Bridge {
  op(op: string, params?: Record<string, unknown>): Promise<unknown>;
  request(type: string, fields: Record<string, unknown>, step: string): Promise<{ type: string; [key: string]: unknown }>;
  send(type: string, fields: Record<string, unknown>): string;
  /** Every frame received so far (bounded by the client). */
  frames(): readonly { type: string; [key: string]: unknown }[];
  close(): void;
}
export interface Boat {
  /** Null when Boat no longer has the machine (404). */
  inspect(machineId: string): Promise<{ name: string | null; state: string } | null>;
  delete(machineId: string): Promise<void>;
}
export interface Storage {
  /** Object keys under a workspace's backup prefix. */
  keys(workspaceId: string): Promise<string[]>;
  delete(key: string): Promise<void>;
}
export interface Github {
  /** Whether a repository exists (and the App's installation can read it). */
  repositoryExists(repository: string): Promise<boolean>;
  /** Creates a private fixture repository with one initial commit; never another owner's. */
  createRepository(repository: string): Promise<void>;
  deleteRepository(repository: string): Promise<void>;
  /** Branches of `repository` whose names start with `prefix`. */
  branches(repository: string, prefix: string): Promise<string[]>;
  deleteBranch(repository: string, branch: string): Promise<void>;
  /** Open pull requests of `repository` whose head branch starts with `prefix`. */
  openPulls(repository: string, prefix: string): Promise<number[]>;
  closePull(repository: string, number: number): Promise<void>;
}
export type Query = (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number }>;
/** The Alpha database through one temporary PlanetScale role (inherits postgres, TTL 3600), minted on first use and
 * deleted by `close()`, which the runner calls at the end of every stage, cleanup and plan. */
export interface Database {
  /** One statement in a READ ONLY transaction with app.system on. */
  read(text: string, values?: unknown[]): Promise<Record<string, unknown>[]>;
  /** One read-write transaction with app.system on; committed when `work` returns, rolled back when it throws. */
  transaction<T>(work: (query: Query) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export interface Clock { now(): number; sleep(ms: number): Promise<void> }

export type Ports = {
  /** Alpha's /v1/release-identity: channel alpha, ready, not in maintenance, cloud healthy. */
  release(): Promise<boolean>;
  api: Api;
  /** A second test account, for checks that must see nothing. */
  other?: Api;
  bridge(workspaceId: string): Promise<Bridge>;
  boat: Boat;
  storage: Storage;
  github: Github;
  database: Database;
  clock: Clock;
};

/** Everything a run created, by kind, so cleanup and the inventory never depend on names a provider chose. */
export type Created = {
  projects: string[]; workspaces: string[]; machines: string[];
  /** Fixture repositories `provision` created this run (removed by cleanup unless --keep-fixtures). */
  repositories: string[];
  branches: { repository: string; name: string }[]; pulls: { repository: string; number: number }[];
};
export type StageResult = { ok: boolean; step?: string; code?: string; skipped?: string; counts?: Record<string, number> };
export type RehearsalState = {
  version: 1; runId: string; prefix: string; startedAt: string;
  organizationId: string; created: Created; stages: Partial<Record<StageName, StageResult>>;
  /** Organization ids a clock shift may touch. */
  organizations: string[];
  shifts: number; machineStarts: number;
};

export type StageContext = {
  ports: Ports; state: RehearsalState; save(): Promise<void>;
  /** R1 always; R2 once provisioned or named; R3 for submodules. */
  repositories: { one: string; two?: string; submodules?: string };
  /** Bounded waits; tests shrink them. */
  timing: { pollMs: number; stateMs: number; copyMs: number; turnMs: number; scanMs: number; archiveScanMs: number };
  /** Step progress: a stage reports each step's name as it starts (the runner keeps only the last). */
  step(name: string): void;
  /** Counts a machine start before it happens; throws past the run's cap. */
  start(kind: string): void;
};
