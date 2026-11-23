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

export const STAGES = ["provision", "setup", "projects", "personal", "retention", "submodules", "waiting"] as const;
export type StageName = (typeof STAGES)[number];
/** Where the organization stages run: the selected test user's Personal organization (Cloud for Pro), or the probe
 * organization (kept for later; needs the organization route's setup). */
export type OwnerKind = "personal" | "organization";
/** The control-plane switches a stage needs on its route. The control plane does not report switches: the operator
 * declares them. On the Personal route every stage but provision also needs CLOUD_V2_PERSONAL_CLOUD_ENABLED. */
export function stageSwitches(stage: StageName, owner: OwnerKind): Switch[] {
  const own: Record<StageName, Switch[]> = { provision: [], setup: [], projects: ["projects"], personal: ["projects"], retention: ["projects", "retention"],
    submodules: ["projects"], waiting: ["projects"] };
  const needed = own[stage];
  return stage === "provision" ? needed : owner === "personal" || stage === "personal" ? [...needed, "personal"] : needed;
}
/** Whether a stage signs in. provision uses only the GitHub App, so it runs whatever happens to an account's sign-in. */
export const STAGE_NEEDS_ACCOUNT: Record<StageName, boolean> = {
  provision: false, setup: true, projects: true, personal: true, retention: true, submodules: true, waiting: true,
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
  /** Boat's own record of a machine's archive, read raw (2026-11-23: a copy stopped while hydrated false with an attempt
   * in progress lost its files). Null when Boat no longer has the machine; any field Boat leaves out is null. */
  snapshot?(machineId: string): Promise<MachineSnapshot | null>;
  delete(machineId: string): Promise<void>;
  /** A Cloud Computer's named snapshot: only the one this run's own base build made is ever deleted. */
  snapshotExists(name: string): Promise<boolean>;
  deleteSnapshot(name: string): Promise<void>;
}
export interface Storage {
  /** Object keys under a workspace's backup prefix. */
  keys(workspaceId: string): Promise<string[]>;
  delete(key: string): Promise<void>;
}
export interface Github {
  /** Whether a repository exists (and the App's installation can read it). */
  repositoryExists(repository: string): Promise<boolean>;
  /** Branches of `repository` whose names start with `prefix`. */
  branches(repository: string, prefix: string): Promise<string[]>;
  deleteBranch(repository: string, branch: string): Promise<void>;
  /** Open pull requests of `repository` whose head branch starts with `prefix`. */
  openPulls(repository: string, prefix: string): Promise<number[]>;
  closePull(repository: string, number: number): Promise<void>;
  /** Whether the default branch's root .gitignore names `path` with a plain rule (`.env`, `.env*`, `*.env`, `/.env`). A
   * seeded environment file must be ignored, or the worker refuses it (cloud_environment_path_ignored_required). */
  ignores(repository: string, path: string): Promise<boolean>;
}
export type MachineSnapshot = { createdAt: string | null; stoppedAt: string | null; hydrated: boolean | null;
  lastSnapshotStatus: string | null; lastSnapshotAttemptAt: string | null; snapshotCompletedAt: string | null };
export type Query = (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number }>;
/** The Alpha database, least privilege first (alpha-operator.md): reads through one temporary read-only role
 * (pg_read_all_data, TTL 3600), minted on first read and deleted by `close()`, which the runner calls at the end of every
 * stage, cleanup and plan; a write through its own owner-level role (inherits postgres), minted for that one
 * transaction and deleted before `transaction` returns. Only shiftClock writes. */
export interface Database {
  /** One statement in a READ ONLY transaction, in the playbook's RLS-safe form (app.system set in a materialized CTE). */
  read(text: string, values?: unknown[]): Promise<Record<string, unknown>[]>;
  /** One read-write transaction with app.system on; committed when `work` returns, rolled back when it throws. Its role
   * is deleted before this returns. */
  transaction<T>(work: (query: Query) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export interface Clock { now(): number; sleep(ms: number): Promise<void> }
/** An account's operator-owned Pro grant, as manage-account-pro.ts reads and writes it. */
export type ProGrant = { enabled: boolean; validFrom: string; validUntil: string | null };
export interface ProPort {
  /** The current grant: null when there is none; "foreign" when billing or a migration owns it (never overwritten). */
  read(): Promise<ProGrant | null | "foreign">;
  /** One change, planned and executed in one process; returns the operation's id. */
  change(grant: ProGrant, reason: string): Promise<string>;
}

export type Ports = {
  /** Alpha's /v1/release-identity: channel alpha, ready, not in maintenance, cloud healthy. */
  release(): Promise<boolean>;
  api: Api;
  /** A second test account, for checks that must see nothing. */
  other?: Api;
  /** The selected account's Individual Pro, through manage-account-pro.ts (plan, then execute, then read back). */
  pro?: ProPort;
  /** The selected account's own GitHub sign-in by token, for the owner organization. The token stays inside the port. */
  githubSignIn?: { connect(organizationId: string, expectedGeneration: string): Promise<void> };
  /** Stage waiting's account (test user 3 by default) and its own fresh Personal organization: the ports that differ
   * for it (its API, Pro and GitHub sign-in; a test may give it a whole fake). */
  waiting?: { organizationId: string; ports: Partial<Omit<Ports, "waiting">> };
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
  branches: { repository: string; name: string }[]; pulls: { repository: string; number: number }[];
  /** The account's environments this run seeded (each was empty before); cleanup clears them. */
  environments: { repository: string; repositoryId: string }[];
  /** The Pro grant before this run's first change (null: none), and the operations made; cleanup puts the grant back. */
  pro?: { before: ProGrant | null; operations: string[] };
  /** Organization ids where this run connected the account's GitHub sign-in by token; cleanup disconnects them. */
  githubSignIns: string[];
  /** The Cloud Computer base build this run requested for the Personal organization. There is no route to remove a Cloud
   * Computer: it and its Boat named snapshot stay after the run, and are reported as such. */
  computerBuild?: string;
  /** Later Cloud Computer builds this run requested (stage C's rebuild); each replaces the live one. */
  computerRebuilds?: string[];
  /** Automatic base builds this run caused (#1260): found by organization, `automatic`, and created after the run
   * started; nobody pressed Build for them. Cleanup removes the live one unless --keep-base. */
  bases?: string[];
  /** Stage waiting set its organization's install script (it had none): cleanup removes it. */
  installScript?: boolean;
};
export type StageResult = { ok: boolean; step?: string; code?: string; skipped?: string; counts?: Record<string, number>;
  /** Closed codes for what a stage chose (environment_case:seeded, environment_skipped:environment_exists). */
  notes?: string[] };
export type RehearsalState = {
  version: 1; runId: string; prefix: string; startedAt: string;
  /** The owner organization the stages run in, and which route it is. */
  owner: OwnerKind; organizationId: string; created: Created; stages: Partial<Record<StageName, StageResult>>;
  /** Organization ids a clock shift may touch. */
  organizations: string[];
  shifts: number; machineStarts: number;
  /** Stage waiting's own organization and what the run created there; cleaned up as the main one is. */
  waiting?: { organizationId: string; created: Created };
};

export type StageContext = {
  ports: Ports; state: RehearsalState; save(): Promise<void>;
  /** Projects are "Only you" (personal) on the Personal route, organization projects on the organization route. */
  projectLevel: "personal" | "organization";
  /** R1 always; R2 by name; for stage D, R3 (two public submodules) and the Withso fixture that
   * is one of them, by name. Every fixture is public. */
  repositories: { one: string; two?: string; submodules?: string; submoduleFixture?: string };
  /** Bounded waits; tests shrink them. */
  timing: { pollMs: number; stateMs: number; copyMs: number; turnMs: number; scanMs: number; archiveScanMs: number;
    /** Pro ended to the machine stopped: the 20-minute idle stop plus one sweep, with margin. */
    idleStopMs: number;
    /** A Cloud Computer base build: one builder machine from Boat's stock image installing the runtime. */
    computerMs: number };
  /** Step progress: a stage reports each step's name as it starts (the runner keeps only the last). */
  step(name: string): void;
  /** Records a closed code for what the stage chose; printed with its result. */
  note(code: string): void;
  /** Counts a machine start before it happens; throws past the run's cap. */
  start(kind: string): void;
};
