// A stateful Boat for tests. It encodes only what we rely on Boat for; each
// assumption is listed in BOAT_FAKE_ASSUMPTIONS and nothing here talks to Boat.
import type { CloudV2CommandResult, CloudV2Compute } from "../boat.js";
import { BoatForkRefusedError, BoatSnapshotExpiredError } from "../boat-client.js";
import { CloudProviderError } from "../provider-error.js";

export const BOAT_FAKE_ASSUMPTIONS = [
  "create and fork are idempotent per key for 24 hours: a replay returns the machine the first request made",
  "a reply can be lost after Boat acted, so the caller sees an error although the machine exists",
  "Boat names every fork \"<source name> fork\", whatever name the request asks for",
  "a fork copies its source's disk, gets no environment of its own, and leaves the source stopped with its stoppedAt unchanged",
  "Boat forks only a machine whose stop has finished archiving; otherwise it refuses before making anything",
  "stop moves a machine to archiving and then archived, recording stoppedAt when the stop is accepted",
  "Boat deletes the disk of a machine stopped for 14 days; resume, inspect and fork then fail as expired",
  "a machine created from a named snapshot starts with that snapshot's disk; a create's env is the only environment a machine has",
  "execLong input reaches the command on standard input through a private file removed before the command runs",
  "delete succeeds when the machine is already gone",
  "findSandbox returns the newest machine with exactly that name",
  "a stopped machine keeps only its disk: a fork boots with none of its source's processes or memory",
] as const;

type Machine = {
  id: string; name: string; state: "running" | "archiving" | "archived" | "deleted";
  env: Record<string, string>; files: Map<string, string>; from: string | null; source: string | null;
  createdAt: number; stoppedAt: number | null;
};
export type FakeCommand = { machineId: string; command: string; input?: string };
type Exec = (machine: Machine, command: string, input?: string) => CloudV2CommandResult | Promise<CloudV2CommandResult> | undefined;

const DAY = 24 * 60 * 60_000;
const lost = () => new CloudProviderError("provider_request_failed", "Boat API request did not succeed", true);

export class FakeBoat implements CloudV2Compute {
  readonly machines = new Map<string, Machine>();
  readonly snapshots = new Map<string, Map<string, string>>();
  readonly commands: FakeCommand[] = [];
  readonly calls: { op: string; args: unknown[] }[] = [];
  private readonly keys = new Map<string, { id: string; at: number }>();
  private readonly lose = new Set<string>();
  private next = 1;
  /** Replies the test scripts; undefined falls through to the default. */
  script: Exec | null = null;
  /** Whether stop goes through "archiving" before "archived". */
  archivingReads = 0;

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
    if (machine.stoppedAt !== null && machine.state !== "running" && this.clock() - machine.stoppedAt >= 14 * DAY) throw new BoatSnapshotExpiredError();
    return machine;
  }
  private keyed(key: string): string | null {
    const entry = this.keys.get(key);
    return entry && this.clock() - entry.at < DAY ? entry.id : null;
  }
  private make(key: string, init: Omit<Machine, "id" | "createdAt" | "stoppedAt" | "state">): string {
    const id = `bx_fake${String(this.next++).padStart(4, "0")}`;
    this.machines.set(id, { ...init, id, state: "running", createdAt: this.clock(), stoppedAt: null });
    this.keys.set(key, { id, at: this.clock() });
    return id;
  }

  async create(input: { key: string; from?: string; name: string; env: Record<string, string> }) {
    this.record("create", input);
    const known = this.keyed(input.key);
    if (known) return this.replied("create", { sandboxId: known });
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
    const id = this.make(input.key, { name: `${source.name} fork`, env: {}, files: new Map(source.files), from: null, source: sourceId });
    return this.replied("fork", { sandboxId: id });
  }

  async inspect(sandboxId: string) {
    this.record("inspect", sandboxId);
    const machine = this.live(sandboxId);
    if (machine.state === "archiving" && this.archivingReads-- <= 0) machine.state = "archived";
    return { name: machine.name, state: machine.state, stoppedAt: machine.stoppedAt === null ? null : new Date(machine.stoppedAt) };
  }

  async resume(sandboxId: string) {
    this.record("resume", sandboxId);
    const machine = this.live(sandboxId);
    machine.state = "running";
  }

  async extendLease(sandboxId: string) { this.record("extendLease", sandboxId); this.live(sandboxId); }

  async stop(sandboxId: string) {
    this.record("stop", sandboxId);
    const machine = this.live(sandboxId);
    if (machine.state === "running") { machine.state = "archiving"; machine.stoppedAt = this.clock(); }
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
    const path = input === undefined ? null : `/tmp/zeros-command-input-${this.next++}/stdin`;
    // Written privately, then removed before the command itself runs.
    if (path) { machine.files.set(path, input!); machine.files.delete(path); }
    return this.run(sandboxId, command, input);
  }

  private async run(sandboxId: string, command: string, input?: string): Promise<CloudV2CommandResult> {
    const machine = this.live(sandboxId);
    if (machine.state !== "running") throw new CloudProviderError("provider_request_failed", "Boat API request did not succeed", true, { httpStatus: 409 });
    this.commands.push({ machineId: sandboxId, command, ...(input === undefined ? {} : { input }) });
    // The ready copy scrub (READY_COPY_SCRUB_COMMAND) removes command inputs and detached job files.
    if (command.includes("rm -rf /tmp/zeros-command-input-* /tmp/zeros-job-*"))
      for (const path of [...machine.files.keys()]) if (/^\/tmp\/zeros-(?:command-input|job)-/.test(path)) machine.files.delete(path);
    // The ready copy secret search (READY_COPY_SECRET_SEARCH_COMMAND): patterns arrive on standard input.
    if (command.startsWith("grep -rlIF -f - /home/user /tmp")) {
      const patterns = (input ?? "").split("\n").filter(Boolean);
      const hit = [...machine.files].find(([path, content]) => /^\/(?:home\/user|tmp)\//.test(path) && patterns.some(pattern => content.includes(pattern)));
      this.commands.push({ machineId: sandboxId, command, ...(input === undefined ? {} : { input }) });
      return { exitCode: 0, stdout: hit ? `${hit[0]}\n` : "", timedOut: false };
    }
    const scripted = await this.script?.(machine, command, input);
    if (scripted) return scripted;
    if (command.includes("rev-parse HEAD"))
      return { exitCode: 0, stdout: `Cloning\nzeros-build-branch=main\n${"c".repeat(40)}\n`, timedOut: false };
    return { exitCode: 0, stdout: "", timedOut: false };
  }

  async saveSnapshot(sandboxId: string, name: string) {
    this.record("saveSnapshot", sandboxId, name);
    this.snapshots.set(name, new Map(this.live(sandboxId).files));
  }

  async deleteSnapshot(name: string) { this.record("deleteSnapshot", name); this.snapshots.delete(name); }

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
