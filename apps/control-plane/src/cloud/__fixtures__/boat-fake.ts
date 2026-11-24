// A stateful Boat for tests. It encodes only what we rely on Boat for; each
// assumption is listed in BOAT_FAKE_ASSUMPTIONS and nothing here talks to Boat.
import { createHash } from "node:crypto";
import type { BoatNamedSnapshotList, CloudV2CommandResult, CloudV2Compute } from "../boat.js";
import { BoatBootPendingError, BoatForkRefusedError, BoatSnapshotExpiredError } from "../boat-client.js";
import { CloudProviderError } from "../provider-error.js";
import { READY_COPY_SECRET_PATHS } from "../ready-copies.js";

/** Measured on Boat (PLAN.md, "Measured on Boat"; `verified` names the date of a live check) or unverified, awaiting one. */
export const BOAT_FAKE_ASSUMPTIONS = [
  { verified: true, assumption: "Boat names every fork \"<source name> fork\"" },
  { verified: true, assumption: "a fork of a stopped machine works and copies its disk; the source's stoppedAt is unchanged" },
  { verified: "2026-11-21", assumption: "a stopped machine whose disk Boat expired still inspects as archived (HTTP 200) with snapshotAvailable false and dataExpiredAt set; resume and fork then fail as expired" },
  { verified: "2026-11-21", assumption: "a machine that can still be resumed inspects with snapshotAvailable true and dataExpiredAt null" },
  // Note (Alpha, read-only, 2026-11-21): expiry usually lands about 14.00 days after stoppedAt, but one machine
  // stopped 16.3 days earlier still read snapshotAvailable true. Read Boat's fields; never compute expiry from stoppedAt.
  { verified: "2026-11-21", assumption: "fork is idempotent per key for 24 hours: a replay returns the machine the first request made" },
  { verified: false, assumption: "the name a fork request asks for is ignored" },
  { verified: "2026-11-21", assumption: "Boat refuses a fork of a machine still archiving (409 fork_failed, \"Fork needs a completed snapshot\") before making anything" },
  { verified: "2026-11-21", assumption: "stoppedAt is null while archiving and set when the machine becomes archived: the archive-end time, not the accept time" },
  { verified: false, assumption: "a reply can be lost after Boat acted, so the caller sees an error although the machine exists" },
  { verified: "2026-11-21", assumption: "a fork carries its source's environment; a fork request's env does not replace it" },
  { verified: "2026-11-21", assumption: "a fork is a fresh boot from its source's disk: none of its source's processes, and its enabled units start" },
  { verified: "2026-11-21", assumption: "worker unit stays disabled: a unit stopped and disabled before a stop is inactive and disabled after resume and in a fork; one left enabled runs in both" },
  { verified: "2026-11-21", assumption: "an explicit stop freezes running processes and resume restores them; a stop is accepted while a command runs and archives normally" },
  { verified: "2026-11-21", assumption: "a lease that runs out archives a running machine (disk kept, stoppedAt set then); the resume after it is a cold start: processes are gone and enabled units start" },
  { verified: "2026-11-21", assumption: "a fork's lease is not a delete: a fork left past its ttlSeconds is archived and stays until Boat's own retention removes it" },
  { verified: "2026-11-21", assumption: "deleting a fork leaves its source's state and stoppedAt unchanged" },
  { verified: "2026-11-21", assumption: "resume of a running machine is harmless: processes keep running, it re-arms the lease, and inspect may report the state as idle" },
  { verified: "2026-11-21", assumption: "a fork accepts commands within seconds, as user with sudo -n systemctl" },
  { verified: false, assumption: "which calls count against Boat's creation-request limits: create and fork are assumed to, resume is assumed to as well" },
  { verified: false, assumption: "execLong input reaches only the last simple command, through a private file removed before it runs" },
  { verified: "2026-11-21", assumption: "delete succeeds when the machine is already gone and inspect then answers 404 not_found" },
  { verified: false, assumption: "findSandbox returns the newest machine with that exact name" },
  { verified: false, assumption: "GET /named-snapshots/<name> answers status \"ready\" for a snapshot that can start a machine and 404 for none, also for the shared Zeros base saved under another Boat organization" },
  // Read on Alpha (read-only): 7 named snapshots, all ready, the oldest 26.9 days old; no expiry field and no paging.
  { verified: true, assumption: "GET /named-snapshots/<name> answers status \"ready\" for this account's own snapshot and 404 with a code for none" },
  { verified: true, assumption: "GET /named-snapshots lists every named snapshot of the account with an allowance { included, free, used, extra, pricePerExtraMonthlyDollars, pricePerExtraDailyDollars }; snapshots beyond included are billed" },
  { verified: false, assumption: "a named snapshot does not expire while it is not deleted" },
  { verified: false, assumption: "a machine's disk holds a project's 10 full clones with their dependencies (about 20-30 GB)" },
  { verified: "2026-11-23", assumption: "inspect reports hydrated, lastSnapshotAttemptAt and lastSnapshotStatus (in_progress | completed | failed)" },
  { verified: "2026-11-23", assumption: "a machine made from a snapshot, or a fork, accepts commands before it reports hydrated" },
  { verified: "2026-11-23", assumption: "a stop while a snapshot attempt is in progress can end with that attempt failed, and a fork of the machine then lacked the files written just before" },
  { verified: "2026-11-23", assumption: "a fork copies its source's archive" },
] as const;

type Machine = {
  id: string; name: string; state: "running" | "archiving" | "archived" | "deleted";
  env: Record<string, string>; files: Map<string, string>; from: string | null; source: string | null;
  createdAt: number; stoppedAt: number | null;
  /** Boat expired this stopped machine's disk (also after 14 days stopped, as usually observed). */
  expired?: boolean;
  /** The worker's systemd unit. A stop freezes it; a fork or a cold resume starts it when enabled. */
  worker: { enabled: boolean; active: boolean };
  /** A fork's lease end; past it Boat archives the fork, and the next resume is cold. */
  leaseUntil: number | null; cold: boolean;
  /** Inspect reads before Boat reports this machine hydrated (its restore settled); 0 means hydrated. */
  hydrateReads: number;
  /** The latest snapshot attempt: when it began, its status, the files as of its start, and the reads before an
   * in-progress one completes. */
  attempt: { at: number; status: "in_progress" | "completed" | "failed"; files: Map<string, string>; reads: number };
  /** What the stop archived when it was not the files as they stood (a stop that failed an attempt in progress). */
  archive: Map<string, string> | null;
  /** What inspect reads report while the machine archives, in order, before the stop's own attempt completes it. */
  stopReads: { at: number; status: "in_progress" | "failed" }[];
};
export type FakeCommand = { machineId: string; command: string; input?: string };
type Exec = (machine: Machine, command: string, input?: string) => CloudV2CommandResult | Promise<CloudV2CommandResult> | undefined;

const DAY = 24 * 60 * 60_000;
const lost = () => new CloudProviderError("provider_request_failed", "Boat API request did not succeed", true);

export class FakeBoat implements CloudV2Compute {
  readonly machines = new Map<string, Machine>();
  readonly snapshots = new Map<string, Map<string, string>>();
  /** Numbers each recorded ignored-file baseline, so a test tells a new one from an inherited one. */
  private baselines = 0;
  readonly commands: FakeCommand[] = [];
  readonly calls: { op: string; args: unknown[] }[] = [];
  private readonly keys = new Map<string, { id: string; at: number }>();
  private readonly lose = new Set<string>();
  private next = 1;
  /** Replies the test scripts; undefined falls through to the default. */
  script: Exec | null = null;
  /** A command the test makes fail at Boat before the machine runs any of it. */
  failCommand: ((machine: Machine, command: string) => boolean) | null = null;
  /** After a resume, this many commands are refused as Boat refuses them while the machine is still starting. */
  startingCommands = 0;
  private starting = new Map<string, number>();
  /** Whether stop goes through "archiving" before "archived". */
  archivingReads = 0;
  /** Inspect reads before a fork, or a machine made from a snapshot, is hydrated. */
  hydrationReads = 0;
  /** The next stop meets a snapshot attempt that began just before it (after the caller's last read): seen in progress
   * for `inProgressReads` reads, then failed for `failedReads`, then the stop's own attempt. */
  attemptAtStop: { inProgressReads: number; failedReads: number } | null = null;
  /** The next saveSnapshot fails with this code after Boat recorded the name, as a failed or timed-out save can. */
  failNextSave: "computer_snapshot_failed" | "computer_snapshot_timeout" | null = null;
  /** The next create is refused outright, before anything exists. */
  refuseNextCreate = false;
  /** Named snapshots Boat bills beyond this many. */
  includedSnapshots = 10;
  /** Names other deployments or people saved on the same account: listed, never this deployment's. */
  readonly foreignSnapshots = new Set<string>();

  constructor(public clock: () => number = () => Date.now()) {}

  /** The next call of `op` acts, then loses its reply. */
  loseNextReply(op: "create" | "fork" | "stop" | "delete"): void { this.lose.add(op); }

  private record(op: string, ...args: unknown[]): void { this.calls.push({ op, args }); }
  private replied<T>(op: string, value: T): T {
    if (this.lose.delete(op)) throw lost();
    return value;
  }
  private live(id: string): Machine {
    const machine = this.machines.get(id);
    if (!machine || machine.state === "deleted") throw new CloudProviderError("provider_not_found", "Boat API request did not succeed", false, { httpStatus: 404 });
    if (machine.state === "running" && machine.leaseUntil !== null && this.clock() >= machine.leaseUntil) {
      machine.state = "archived"; machine.stoppedAt = machine.leaseUntil; machine.cold = true;
    }
    if (this.expired(machine)) throw new BoatSnapshotExpiredError();
    return machine;
  }
  private expired(machine: Machine): boolean {
    return machine.state !== "running" && (machine.expired === true || (machine.stoppedAt !== null && this.clock() - machine.stoppedAt >= 14 * DAY));
  }
  private keyed(key: string): string | null {
    const entry = this.keys.get(key);
    return entry && this.clock() - entry.at < DAY ? entry.id : null;
  }
  private make(key: string, init: Omit<Machine, "id" | "createdAt" | "stoppedAt" | "state" | "worker" | "leaseUntil" | "cold" | "hydrateReads" | "attempt" | "archive" | "stopReads">
    & Partial<Pick<Machine, "worker" | "leaseUntil">>): string {
    const id = `bx_fake${String(this.next++).padStart(4, "0")}`;
    this.machines.set(id, { worker: { enabled: false, active: false }, leaseUntil: null, ...init, id, state: "running", createdAt: this.clock(), stoppedAt: null, cold: false,
      hydrateReads: init.from || init.source ? this.hydrationReads : 0, attempt: { at: this.clock(), status: "completed", files: new Map(init.files), reads: 0 },
      archive: null, stopReads: [] });
    this.keys.set(key, { id, at: this.clock() });
    return id;
  }

  async create(input: { key: string; from?: string; name: string; env: Record<string, string> }) {
    this.record("create", input);
    const known = this.keyed(input.key);
    if (known) return this.replied("create", { sandboxId: known });
    if (this.refuseNextCreate) {
      this.refuseNextCreate = false;
      throw new CloudProviderError("provider_request_failed", "Boat API request did not succeed", false, { httpStatus: 400 });
    }
    const files = new Map(input.from ? this.snapshots.get(input.from) ?? [] : []);
    const id = this.make(input.key, { name: input.name, env: { ...input.env }, files, from: input.from ?? null, source: null });
    return this.replied("create", { sandboxId: id });
  }

  async fork(sourceId: string, input: { key: string; name?: string; ttlSeconds: number }) {
    this.record("fork", sourceId, input);
    const known = this.keyed(input.key);
    if (known) return this.replied("fork", { sandboxId: known });
    const source = this.live(sourceId);
    if (source.state !== "archived") throw new BoatForkRefusedError();
    const id = this.make(input.key, { name: `${source.name} fork`, env: { ...source.env }, files: new Map(source.archive ?? source.files), from: null, source: sourceId,
      worker: { enabled: source.worker.enabled, active: source.worker.enabled }, leaseUntil: this.clock() + input.ttlSeconds * 1000 });
    return this.replied("fork", { sandboxId: id });
  }

  async inspect(sandboxId: string) {
    this.record("inspect", sandboxId);
    const known = this.machines.get(sandboxId);
    // An expired disk still answers inspect: archived, no snapshot, and when Boat expired it.
    if (known && known.state !== "deleted" && this.expired(known))
      return { name: known.name, state: "archived", stoppedAt: known.stoppedAt === null ? null : new Date(known.stoppedAt), snapshotAvailable: false,
        dataExpiredAt: new Date(known.stoppedAt === null ? this.clock() : Math.min(this.clock(), known.stoppedAt + 14 * DAY)) };
    const machine = this.live(sandboxId);
    if (machine.hydrateReads > 0) machine.hydrateReads--;
    const attempt = machine.attempt;
    if (attempt.status === "in_progress" && machine.state === "running" && attempt.reads-- <= 0) attempt.status = "completed";
    // A stop that met an attempt in progress: what the reads report of it first; then the stop's own attempt.
    if (machine.state === "archiving" && machine.stopReads.length) {
      const seen = machine.stopReads.shift()!;
      return { name: machine.name, state: machine.state, stoppedAt: null, ...this.disk(machine, seen) };
    }
    if (machine.state === "archiving" && this.archivingReads-- <= 0) {
      machine.state = "archived"; machine.stoppedAt = this.clock();
      machine.attempt = { at: Math.max(this.clock(), machine.attempt.at + 1), status: "completed", files: new Map(machine.archive ?? machine.files), reads: 0 };
    }
    return { name: machine.name, state: machine.state, stoppedAt: machine.stoppedAt === null ? null : new Date(machine.stoppedAt),
      ...(machine.state === "archived" ? { snapshotAvailable: true, dataExpiredAt: null } : {}), ...this.disk(machine, machine.attempt) };
  }

  private disk(machine: Machine, attempt: { at: number; status: string }) {
    return { hydrated: machine.hydrateReads === 0, snapshotAttemptAt: new Date(attempt.at), snapshotStatus: attempt.status };
  }

  /** A snapshot attempt of a running machine begins: it holds the files as they are now, and completes after `reads`
   * inspect reads unless a stop comes first, which fails it. */
  beginSnapshotAttempt(sandboxId: string, reads = Number.POSITIVE_INFINITY): void {
    const machine = this.live(sandboxId);
    machine.attempt = { at: Math.max(this.clock(), machine.attempt.at + 1), status: "in_progress", files: new Map(machine.files), reads };
  }

  async resume(sandboxId: string, ttlSeconds?: number) {
    this.record("resume", sandboxId, ...(ttlSeconds === undefined ? [] : [ttlSeconds]));
    const machine = this.live(sandboxId);
    if (machine.cold) { machine.worker.active = machine.worker.enabled; machine.cold = false; }
    // A resume starts from what the stop archived, and from a stopped machine its restore runs again for a while.
    if (machine.archive) { machine.files = new Map(machine.archive); machine.archive = null; }
    if (machine.state !== "running") machine.hydrateReads = this.hydrationReads;
    if (this.startingCommands) this.starting.set(sandboxId, this.startingCommands);
    // Boat's lease is the resume's ttl; boat.ts sends 24 hours when none is given.
    machine.state = "running"; machine.leaseUntil = this.clock() + (ttlSeconds ?? 24 * 60 * 60) * 1000;
  }

  async extendLease(sandboxId: string) { this.record("extendLease", sandboxId); this.live(sandboxId); }

  async stop(sandboxId: string) {
    this.record("stop", sandboxId);
    const machine = this.live(sandboxId);
    if (machine.state === "running") {
      machine.state = "archiving";
      const gap = this.attemptAtStop;
      this.attemptAtStop = null;
      if (gap) machine.attempt = { at: Math.max(this.clock(), machine.attempt.at + 1), status: "in_progress", files: new Map(machine.files), reads: Number.POSITIVE_INFINITY };
      // Stopped during an attempt: it fails, and the archive holds only what that attempt began with.
      if (machine.attempt.status === "in_progress") {
        const at = machine.attempt.at;
        machine.stopReads = gap ? [...Array<{ at: number; status: "in_progress" }>(gap.inProgressReads).fill({ at, status: "in_progress" }),
          ...Array<{ at: number; status: "failed" }>(gap.failedReads).fill({ at, status: "failed" })] : [{ at, status: "failed" }];
        machine.attempt.status = "failed"; machine.archive = new Map(machine.attempt.files);
      } else { machine.archive = null; machine.stopReads = []; }
    }
    this.replied("stop", undefined);
  }

  async delete(sandboxId: string) {
    this.record("delete", sandboxId);
    const machine = this.machines.get(sandboxId);
    if (machine) machine.state = "deleted";
    this.replied("delete", undefined);
  }

  async exec(sandboxId: string, command: string): Promise<CloudV2CommandResult> {
    return this.run(sandboxId, command);
  }

  async execLong(sandboxId: string, command: string, _timeoutSeconds: number, input?: string): Promise<CloudV2CommandResult> {
    const machine = this.live(sandboxId);
    // Boat's long commands append the input redirect to the command line, so it
    // reaches only the last simple command: a command taking input is one quoted invocation.
    if (input !== undefined && !/^(?:sudo -n )?bash -l?c '(?:[^']|'\\'')*'(?: 2>&1)?$/.test(command))
      throw new Error(`fake Boat: input would not reach this command: ${command.slice(0, 80)}`);
    const path = input === undefined ? null : `/tmp/zeros-command-input-${this.next++}/stdin`;
    // Written privately, then removed before the command itself runs.
    if (path) { machine.files.set(path, input!); machine.files.delete(path); }
    return this.run(sandboxId, command, input);
  }

  private async run(sandboxId: string, command: string, input?: string): Promise<CloudV2CommandResult> {
    const machine = this.live(sandboxId);
    if (machine.state !== "running") throw new CloudProviderError("provider_request_failed", "Boat API request did not succeed", true, { httpStatus: 409 });
    const starting = this.starting.get(sandboxId) ?? 0;
    if (starting) { this.starting.set(sandboxId, starting - 1); throw new BoatBootPendingError(); }
    this.commands.push({ machineId: sandboxId, command, ...(input === undefined ? {} : { input }) });
    if (this.failCommand?.(machine, command)) throw lost();
    if (command.includes("systemctl stop zeros-worker.service")) machine.worker.active = false;
    if (command.includes("systemctl disable zeros-worker.service")) machine.worker.enabled = false;
    if (command.includes("systemctl enable zeros-worker.service")) machine.worker.enabled = true;
    if (command.includes("systemctl restart zeros-worker.service")) machine.worker.active = true;
    if (command.includes("zeros-worker-unit"))
      return { exitCode: 0, stdout: `zeros-worker-unit enabled=${machine.worker.enabled ? "enabled" : "disabled"} active=${machine.worker.active ? "active" : "inactive"}\n`, timedOut: false };
    // The ready copy scrub (READY_COPY_SCRUB_COMMAND) removes command inputs and detached job files.
    if (command.includes("rm -rf /tmp/zeros-command-input-* /tmp/zeros-job-*"))
      for (const path of [...machine.files.keys()]) if (/^\/tmp\/zeros-(?:command-input|job)-/.test(path)) machine.files.delete(path);
    if (command.includes("grep -lsIF -f")) {
      // The secret search (READY_COPY_SECRET_SEARCH_COMMAND) over READY_COPY_SECRET_PATHS, skipping .git/objects.
      const patterns = (input ?? "").split("\n").filter(Boolean);
      const hit = [...machine.files].find(([path, content]) => READY_COPY_SECRET_PATHS.some(root => path.startsWith(`${root}/`))
        && !path.includes("/.git/objects/") && patterns.some(pattern => content.includes(pattern)));
      const scripted = await this.script?.(machine, command, input);
      if (scripted) return scripted;
      return { exitCode: 0, stdout: `zeros-search-bytes=1024 zeros-search-limit=300\n${hit ? `${hit[0]}\n` : ""}zeros-search-status=${hit ? "141,141" : "0,0"}\n`, timedOut: false };
    }
    const scripted = await this.script?.(machine, command, input);
    if (scripted) return scripted;
    // A planned submodule's fetch (cloud/submodules.ts submoduleFetchLines): its work tree's .git and its module
    // directory, with the gitlink commit checked out; refused when either is already there.
    if (command.includes("zeros-submodule-fetched")) {
      const plain = command.replace(/'\\''/g, "'");
      const clone = /--separate-git-dir='([^']+)' -- 'https:\/\/github\.com\/([^']+)\.git' '([^']+)'/.exec(plain);
      const commit = /checkout --quiet --detach ([0-9a-f]{40,64})/.exec(plain)?.[1];
      if (!clone || !commit) return { exitCode: 1, stdout: "", timedOut: false };
      const [, gitDir, repository, target] = clone as unknown as [string, string, string, string];
      // Already there: moved to the planned commit only when its work tree points at the planned Git directory.
      const existing = machine.files.get(`${target}/.git`);
      if ((existing !== undefined || machine.files.has(`${gitDir}/HEAD`)) && existing !== `gitdir: ${gitDir}`)
        return { exitCode: 3, stdout: "zeros-submodule-refused existing\n", timedOut: false };
      machine.files.set(`${target}/.git`, `gitdir: ${gitDir}`);
      machine.files.set(`${gitDir}/HEAD`, commit);
      machine.files.set(`${gitDir}/origin`, `https://github.com/${repository}.git`);
      return { exitCode: 0, stdout: "zeros-submodule-fetched\n", timedOut: false };
    }
    // The ignored-file baseline (checkpoint.ts ignoredBaselineCommand): one file per checkout, named by its
    // path, under the home's retention-baseline directory; an existing one is never replaced. The project
    // builder's command (ready-copies.ts readyCopyBaselineCommand) removes the directory first.
    if (command.includes("zeros-baseline recorded")) {
      if (command.startsWith("rm -rf -- '/home/user/.local/share/zeros/retention-baseline' && "))
        for (const path of [...machine.files.keys()]) if (path.startsWith("/home/user/.local/share/zeros/retention-baseline/")) machine.files.delete(path);
      for (const path of new Set(command.match(/\/home\/user\/(?!\.local\/)[A-Za-z0-9._/-]+/g) ?? [])) {
        const file = `/home/user/.local/share/zeros/retention-baseline/${createHash("sha256").update(path).digest("hex")}`;
        if (!machine.files.has(file)) machine.files.set(file, `baseline ${++this.baselines} of ${path}`);
      }
      return { exitCode: 0, stdout: "zeros-baseline recorded\n", timedOut: false };
    }
    // Which checkouts a machine holds (ready-copies.ts readyCopyCheckoutsCommand): each one's HEAD, or missing.
    if (command.includes("zeros-checkouts-read")) {
      const dirs = [...command.replace(/'\\''/g, "'").matchAll(/zeros-checkout-at '([^']+)'/g)].map(match => match[1]!);
      return { exitCode: 0, stdout: `${dirs.map((dir, index) => `zeros-checkout ${index} ${machine.files.get(`${dir}/.git/HEAD`) ?? "missing"}`).join("\n")}\nzeros-checkouts-read\n`, timedOut: false };
    }
    if (command.includes("rev-parse HEAD")) {
      // A clone (computer.ts checkoutScript) leaves its checkout on the disk.
      const target = /clone (?:--branch '[^']*' )?'https:\/\/github\.com\/[^']+\.git' '([^']+)'/.exec(command.replace(/'\\''/g, "'"))?.[1];
      if (target) machine.files.set(`${target}/.git/HEAD`, "c".repeat(40));
      return { exitCode: 0, stdout: `Cloning\nzeros-build-branch=main\n${"c".repeat(40)}\n`, timedOut: false };
    }
    return { exitCode: 0, stdout: "", timedOut: false };
  }

  async saveSnapshot(sandboxId: string, name: string) {
    this.record("saveSnapshot", sandboxId, name);
    this.snapshots.set(name, new Map(this.live(sandboxId).files));
    const failure = this.failNextSave;
    if (failure) { this.failNextSave = null; throw Object.assign(new Error("snapshot save failed"), { code: failure }); }
  }

  async listNamedSnapshots(): Promise<BoatNamedSnapshotList> {
    this.record("listNamedSnapshots");
    const names = [...this.snapshots.keys(), ...[...this.foreignSnapshots].filter(name => !this.snapshots.has(name))];
    return {
      snapshots: names.map(name => ({ name, status: "ready", createdAt: new Date(this.clock()).toISOString() })),
      allowance: { included: this.includedSnapshots, used: names.length, extra: Math.max(0, names.length - this.includedSnapshots), pricePerExtraMonthlyDollars: 1.68 },
    };
  }

  async deleteSnapshot(name: string) { this.record("deleteSnapshot", name); this.snapshots.delete(name); }

  async snapshotExists(name: string) { this.record("snapshotExists", name); return this.snapshots.has(name) && !this.notReady.has(name); }
  /** Names Boat lists but not as ready (a status other than ready): snapshotState answers unknown for them. */
  readonly notReady = new Set<string>();
  async snapshotState(name: string): Promise<"present" | "absent" | "unknown"> {
    this.record("snapshotState", name);
    return !this.snapshots.has(name) ? "absent" : this.notReady.has(name) ? "unknown" : "present";
  }

  async hostPort(sandboxId: string, input: { port: number }) {
    this.record("hostPort", sandboxId, input);
    this.live(sandboxId);
    return { url: `https://${sandboxId}-${input.port}.on.boat.dev`, token: "fixture-route-token-000000" };
  }

  async findSandbox(name: string): Promise<string | null> {
    this.record("findSandbox", name);
    const matches = [...this.machines.values()].filter(machine => machine.name === name && machine.state !== "deleted");
    return matches.sort((a, b) => b.createdAt - a.createdAt)[0]?.id ?? null;
  }

  /** Lets a scripted command leave something on the disk, as a setup could. */
  write(sandboxId: string, path: string, content: string): void { this.live(sandboxId).files.set(path, content); }
  machine(id: string): Machine | undefined { return this.machines.get(id); }
  /** Shortcut for tests that need a ready copy's source: a stopped machine. */
  stopped(name: string, files: Record<string, string> = {}): string {
    const id = this.make(`fixture:${name}:${this.next}`, { name, env: {}, files: new Map(Object.entries(files)), from: null, source: null });
    const machine = this.machines.get(id)!;
    machine.state = "archived"; machine.stoppedAt = this.clock();
    return id;
  }
}
