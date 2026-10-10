import { randomUUID } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { currentPtyHostBirth } from "../../pty/pty-host-client";
import {
  ResidentWorkloadAuthoritySchema, ResidentWorkloadCensusRequestSchema, ResidentWorkloadClassificationSchema,
  residentWorkloadClassificationMatchesRequest,
  type ResidentQuietTerminal, type ResidentWorkloadAuthority, type ResidentWorkloadBirth,
  type ResidentWorkloadCensusRequest, type ResidentWorkloadClassification,
} from "../../pty/resident-protocol";
import {
  cloudWorkloadCustodyInfrastructure, isCloudWorkloadCustody, type CloudWorkloadCustody,
  type CloudWorkloadControllerBirth,
} from "./cloud-workload-custody";
import type { CloudWorkloadCensus } from "./cloud-workload-cgroup.mjs";
import { HostExecutionBoundary, hostCloudWorkloadCustody, hostFenceUnstartedLaunches, hostOwnedLifecycleSnapshot } from "./host-boundary";
import { AdmissionCancelledError, type AdmissionControl, type BoundaryRequest, type PreparedBoundary, type TerritoryGeneration } from "./types";

export type CloudWorkloadKind = "agent" | "repo-task" | "terminal" | "ssh" | "language-service" | "service";
export type CloudWorkloadRole = "workload" | "infrastructure";
export interface CloudWorkloadFence { readonly id: string }
/** Only this original resident owner's Host groups. This receipt grants no
 * aggregate quiescence, checkpoint/seal or final VM retirement authority. */
export interface CloudOwnedGroupDrainProof {
  readonly kind: "owner-process-groups";
  readonly fenceId: string;
  readonly owner: CloudWorkloadControllerBirth;
}
export interface CloudOwnedWorkloadSnapshot {
  readonly complete: boolean;
  readonly pendingLaunches: number;
  readonly failedRetirements: number;
  readonly scopes: readonly { executionId: string; generation: TerritoryGeneration; kind: CloudWorkloadKind;
    role: CloudWorkloadRole; state: "preparing" | "active" | "stopping" | "failed"; processGroups: readonly number[] }[];
}
export interface CloudOwnedWorkloadInspection {
  readonly complete: boolean; readonly pendingLaunches: number; readonly failedRetirements: number;
  readonly workloadPids: readonly number[]; readonly infrastructurePids: readonly number[];
  readonly quietTerminalPids?: readonly number[];
  readonly censusSha256?: string | null;
}
/** An engine-owned captured authenticated channel. Its classification cannot
 * add infrastructure: the owner birth must already be root projected. */
export interface CloudWorkloadOwnerChannel {
  readonly authority: ResidentWorkloadAuthority;
  readonly owner: ResidentWorkloadBirth;
  assertLive(): void;
  classifyWorkloads(request: ResidentWorkloadCensusRequest): Promise<ResidentWorkloadClassification | null>;
}
interface OriginalOwnerChannel extends CloudWorkloadOwnerChannel { readonly source: CloudWorkloadOwnerChannel }
interface Scope {
  executionId: string; generation: TerritoryGeneration; kind: CloudWorkloadKind; role: CloudWorkloadRole;
  state: "preparing" | "active" | "stopping" | "failed"; controller: AbortController; signal: AbortSignal;
  host: HostExecutionBoundary; prepared?: PreparedBoundary; ready: Promise<void>; resolveReady(): void;
  stopping?: Promise<void>;
  terminalIdle?: () => unknown;
  observed: Map<number, string>;
}
interface KernelProcess { pid: number; parent: number; group: number; session: number; tty: number; foreground: number; startTicks: string; state: string }
async function kernelProcesses(): Promise<Map<number, KernelProcess>> {
  if (process.platform !== "linux") throw new Error("cloud process inspection requires Linux");
  const entries = (await readdir("/proc")).filter((value) => /^\d+$/.test(value));
  if (entries.length > 32768) throw new Error("cloud process inspection exceeds capacity");
  const processes = new Map<number, KernelProcess>();
  for (const entry of entries) {
    let source: string;
    try { source = await readFile(`/proc/${entry}/stat`, "utf8"); }
    catch (error) { if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) continue; throw error; }
    const end = source.lastIndexOf(")"), fields = source.slice(end + 1).trim().split(/\s+/);
    const pid = Number(entry), parent = Number(fields[1]), group = Number(fields[2]), session = Number(fields[3]);
    const tty = Number(fields[4]), foreground = Number(fields[5]), startTicks = fields[19];
    if (end < 0 || !source.startsWith(`${entry} (`) || !startTicks || !/^\d+$/.test(startTicks) ||
      ![pid, parent, group, session, tty, foreground].every(Number.isSafeInteger) || pid <= 0 || parent < 0 || group < 0 || session < 0)
      throw new Error("cloud process inspection has invalid kernel identity");
    processes.set(pid, { pid, parent, group, session, tty, foreground, startTicks, state: fields[0]! });
  }
  return processes;
}
interface FailedPreparation {
  readonly scope: Scope;
  proved: boolean;
  consuming?: Promise<void>;
}
const originalRegistries = new WeakSet<object>();
const fenceOwners = new WeakMap<object, { registry: CloudOwnedWorkloadRegistry; drained: boolean; preserveActive: boolean;
  joined: boolean; ownedProof: CloudOwnedGroupDrainProof | null }>();
const originalScopes = new WeakMap<object, { registry: CloudOwnedWorkloadRegistry; scope: Scope }>();
export function isCloudOwnedWorkloadRegistry(value: unknown): value is CloudOwnedWorkloadRegistry {
  return typeof value === "object" && value !== null && originalRegistries.has(value);
}
export function assertCloudOwnedScopeLive(boundary: PreparedBoundary): void {
  const owner = originalScopes.get(boundary);
  if (!owner) throw new Error("cloud workload requires its original prepared scope");
  owner.registry.assertScope(owner.scope);
}

/** Lifecycle ownership only. The VM is the isolation boundary. */
export class CloudOwnedWorkloadRegistry {
  private readonly scopes = new Set<Scope>();
  private readonly failedPreparations = new Map<string, FailedPreparation>();
  private readonly fences = new Set<CloudWorkloadFence>();
  private readonly maxScopes: number;
  readonly custody: CloudWorkloadCustody | null;
  private readonly owners = new Set<OriginalOwnerChannel>();
  private overflow = false;
  constructor(options: { maxScopes?: number; custody?: CloudWorkloadCustody } = {}) {
    if (options.custody !== undefined && !isCloudWorkloadCustody(options.custody))
      throw new Error("cloud workload custody requires its original controller");
    this.custody = options.custody ?? null;
    this.maxScopes = options.maxScopes ?? 1024;
    if (!Number.isSafeInteger(this.maxScopes) || this.maxScopes < 1 || this.maxScopes > 4096)
      throw new Error("invalid cloud workload inventory capacity");
    originalRegistries.add(this);
  }
  assertAccepting(): void {
    if (this.fences.size || this.overflow) throw new AdmissionCancelledError("cloud workload admission is fenced");
    this.custody?.assertLive();
  }
  assertScope(scope: Scope): void {
    this.assertAccepting();
    if (!this.scopes.has(scope) || scope.state !== "active" || scope.signal.aborted)
      throw new AdmissionCancelledError("cloud workload scope is retired");
  }
  fence(options: { preserveActive?: boolean } = {}): CloudWorkloadFence {
    const ticket = Object.freeze({ id: randomUUID() });
    const preserveActive = options.preserveActive === true;
    this.fences.add(ticket); fenceOwners.set(ticket, { registry: this, drained: false, preserveActive, joined: false, ownedProof: null });
    for (const scope of this.scopes) if (!preserveActive || scope.state === "preparing")
      scope.controller.abort(new AdmissionCancelledError("cloud workloads are draining"));
    return ticket;
  }
  private ticket(ticket: CloudWorkloadFence) {
    const owner = fenceOwners.get(ticket);
    if (owner?.registry !== this || !this.fences.has(ticket)) throw new Error("cloud workload fence is not current and original");
    return owner;
  }
  async joinPending(ticket: CloudWorkloadFence): Promise<void> {
    const owner = this.ticket(ticket);
    if (!owner.preserveActive) throw new Error("cloud admission join requires its preserved-owner ticket");
    const results = await Promise.allSettled([...this.scopes].map(async scope => {
      await scope.ready;
      if (!this.scopes.has(scope)) return;
      if (scope.state !== "active" || scope.signal.aborted) await this.retire(scope);
      else if (scope.prepared) await hostFenceUnstartedLaunches(scope.prepared);
    }));
    const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) throw failures.length === 1 ? failures[0] : new AggregateError(failures, "cloud admission join failed");
    const snapshot = this.snapshot();
    if (!snapshot.complete || snapshot.pendingLaunches || snapshot.failedRetirements) throw new Error("cloud admission fence has unresolved scopes");
    owner.joined = true;
  }
  private async drainOwnerScopes(): Promise<void> {
    const results = await Promise.allSettled([...this.scopes].map(async (scope) => {
      await scope.ready;
      if (this.scopes.has(scope)) await this.retire(scope);
    }));
    const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) throw failures.length === 1 ? failures[0] : new AggregateError(failures, "cloud workload retirement failed");
    if (this.scopes.size) throw new Error("cloud workload drain has unresolved scopes");
    this.overflow = false;
    const snapshot = this.snapshot();
    if (!snapshot.complete || snapshot.pendingLaunches || snapshot.failedRetirements)
      throw new Error("cloud owner group drain has unresolved preparation proofs");
  }
  /** A preserved resident cannot remint its old infrastructure evidence to
   * exempt a successor engine. Retire its own ORIGINAL groups and pending
   * launches, then let the current engine prove aggregate tree quiescence. */
  async drainOwned(ticket: CloudWorkloadFence): Promise<CloudOwnedGroupDrainProof> {
    const owner = this.ticket(ticket), custody = this.custody;
    if (!custody || custody.controller.kind !== "resident") throw new Error("owner group drain requires original resident custody");
    custody.assertLive();
    await this.drainOwnerScopes();
    this.ticket(ticket); custody.assertLive();
    owner.ownedProof ??= Object.freeze({ kind: "owner-process-groups" as const, fenceId: ticket.id, owner: custody.controller });
    return owner.ownedProof;
  }
  resumeOwned(ticket: CloudWorkloadFence): void {
    const owner = this.ticket(ticket), custody = this.custody, snapshot = this.snapshot();
    if (!custody || custody.controller.kind !== "resident" || !owner.ownedProof || this.overflow ||
      !snapshot.complete || snapshot.pendingLaunches || snapshot.failedRetirements || this.scopes.size)
      throw new Error("resident fence has no original owner group proof");
    custody.assertLive();
    this.fences.delete(ticket);
  }
  async drain(ticket: CloudWorkloadFence): Promise<void> {
    const owner = this.ticket(ticket);
    await this.drainOwnerScopes();
    const inventory = await this.inspect();
    if (!inventory.complete || inventory.pendingLaunches || inventory.failedRetirements ||
      inventory.workloadPids.length || inventory.quietTerminalPids?.length ||
      (!this.custody && inventory.infrastructurePids.length))
      throw new Error("cloud workload drain is not positively empty");
    this.ticket(ticket);
    owner.drained = true;
  }
  resume(ticket: CloudWorkloadFence): void {
    const owner = this.ticket(ticket);
    const snapshot = this.snapshot();
    if (this.overflow || (owner.preserveActive
      ? (!owner.joined && !owner.drained) || !snapshot.complete || !!snapshot.pendingLaunches || !!snapshot.failedRetirements
      : !owner.drained || !!this.scopes.size)) throw new Error("cloud workload fence has no completed drain proof");
    this.fences.delete(ticket);
  }
  snapshot(): CloudOwnedWorkloadSnapshot {
    let pendingLaunches = 0, failedRetirements = 0, complete = !this.overflow;
    const scopes = [...this.scopes].map((scope) => {
      const state = scope.prepared ? hostOwnedLifecycleSnapshot(scope.prepared) : null;
      if (scope.state === "preparing") pendingLaunches++;
      if (scope.state === "failed") failedRetirements++;
      if (scope.prepared && !state) complete = false;
      pendingLaunches += state?.pendingLaunches ?? 0;
      return { executionId: scope.executionId, generation: scope.generation, kind: scope.kind, role: scope.role,
        state: scope.state, processGroups: state?.groups.map((group) => group.pid) ?? [] };
    });
    return { complete: complete && !pendingLaunches && !failedRetirements, pendingLaunches, failedRetirements, scopes };
  }
  private members(scope: Scope, processes: Map<number, KernelProcess>, requireOriginalGroupBirth = false) {
    const groups = scope.prepared ? hostOwnedLifecycleSnapshot(scope.prepared)?.groups ?? [] : [];
    const members = new Map<number, KernelProcess>();
    let complete = true;
    for (const group of groups) {
      const root = processes.get(group.pid);
      if (root && (!group.startTicks || root.startTicks !== group.startTicks || root.pid === process.pid)) {
        complete = false; continue;
      }
      // An absent leader no longer binds this numeric PGID to the original
      // cloud infrastructure scope. Only exact previously observed births
      // and their descendants may seed exemptions after that leader exits.
      if (requireOriginalGroupBirth && !root) continue;
      for (const process of processes.values()) if (process.group === group.pid) members.set(process.pid, process);
    }
    // Descendant ownership is derived only from an original registered group.
    // Retain its start token if it changes job group or is later reparented.
    for (const [pid, token] of scope.observed) {
      const process = processes.get(pid);
      if (process?.startTicks === token) members.set(pid, process);
    }
    const children = new Map<number, KernelProcess[]>();
    for (const process of processes.values()) {
      const siblings = children.get(process.parent) ?? [];
      siblings.push(process); children.set(process.parent, siblings);
    }
    const pending = [...members.values()];
    for (let index = 0; index < pending.length; index++) {
      for (const child of children.get(pending[index]!.pid) ?? []) if (!members.has(child.pid)) {
        members.set(child.pid, child); pending.push(child);
      }
      if (members.size > 4096) { complete = false; break; }
    }
    if (complete) for (const member of members.values()) scope.observed.set(member.pid, member.startTicks);
    if (scope.observed.size > 4096) complete = false;
    return { complete, groups, members: [...members.values()].filter((member) => member.state !== "Z" && member.state !== "X") };
  }
  registerOwner(channel: CloudWorkloadOwnerChannel): () => void {
    if (!this.custody || this.owners.size >= 16 || [...this.owners].some(owner => owner.source === channel || owner.owner.pid === channel.owner.pid))
      throw new Error("cloud workload owner channel is not original and unique");
    const authority = ResidentWorkloadAuthoritySchema.parse(channel.authority);
    const owner = cloudWorkloadCustodyInfrastructure(this.custody).find(birth => birth.kind === "resident" &&
      birth.pid === channel.owner.pid && birth.startToken === channel.owner.startToken && birth.controlDirectory);
    if (!owner || typeof channel.assertLive !== "function" || typeof channel.classifyWorkloads !== "function")
      throw new Error("cloud workload owner is not root projected");
    channel.assertLive();
    const captured: OriginalOwnerChannel = Object.freeze({ source: channel, authority: Object.freeze(authority),
      owner: Object.freeze({ pid: owner.pid, startToken: owner.startToken }),
      assertLive: channel.assertLive.bind(channel), classifyWorkloads: channel.classifyWorkloads.bind(channel) });
    this.owners.add(captured);
    return () => { this.owners.delete(captured); };
  }
  private quietTerminal(row: ResidentQuietTerminal, owner: ResidentWorkloadBirth, census: CloudWorkloadCensus): boolean {
    const root = census.processes.find(member => member.pid === row.supervisor.pid);
    const shell = census.processes.find(member => member.pid === row.shell.pid);
    const transport = this.originalPtyHost(census);
    const originalParent = root?.parent === owner.pid || owner.pid === this.custody?.controller.pid &&
      owner.startToken === this.custody.controller.startToken && root?.parent === transport;
    if (!root || !shell || root.startToken !== row.supervisor.startToken || shell.startToken !== row.shell.startToken ||
      root.uid !== 10003 || shell.uid !== 10003 || !originalParent || root.group !== root.pid || root.session !== root.pid ||
      shell.parent !== root.pid || shell.session !== root.session || !root.tty || shell.tty !== root.tty ||
      shell.state !== "S" || shell.foreground !== shell.group || root.foreground !== shell.group ||
      shell.executable?.dev !== row.targetExecutable.dev || shell.executable.ino !== row.targetExecutable.ino || !row.noRecentInput)
      return false;
    const descendants = new Set([root.pid, shell.pid]);
    for (let index = 0; index <= census.processes.length; index++) {
      const before = descendants.size;
      for (const member of census.processes)
        if (descendants.has(member.parent) || member.session === root.session || member.group === root.group) descendants.add(member.pid);
      if (descendants.size > 2) return false;
      if (descendants.size === before) return true;
    }
    return false;
  }
  private originalPtyHost(census: CloudWorkloadCensus): number | null {
    const controller = this.custody?.controller, birth = currentPtyHostBirth();
    if (!controller || controller.kind !== "engine" || !birth || birth.parent !== controller.pid) return null;
    const owner = census.processes.find(member => member.pid === controller.pid);
    const transport = census.processes.find(member => member.pid === birth.pid);
    if (!owner || owner.startToken !== controller.startToken || owner.uid !== 10003 || !census.infrastructurePids.includes(owner.pid) ||
      !transport || transport.uid !== 10003 || transport.startToken !== birth.startToken || transport.parent !== owner.pid ||
      transport.directory !== owner.directory) return null;
    return transport.pid;
  }
  private quietTerminals(census: CloudWorkloadCensus): ResidentQuietTerminal[] {
    if (!this.custody) return [];
    const rows: ResidentQuietTerminal[] = [];
    for (const scope of this.scopes) {
      if (scope.kind !== "terminal" || scope.role !== "workload" || scope.state !== "active" || scope.signal.aborted || !scope.prepared) continue;
      let idle = false;
      try {
        const result = scope.terminalIdle?.(); idle = result === true;
        if (result && typeof result === "object") void Promise.resolve(result).catch(() => undefined);
      } catch { /* no quiet proof */ }
      if (!idle) continue;
      for (const group of hostOwnedLifecycleSnapshot(scope.prepared)?.groups ?? []) {
        const root = census.processes.find(member => member.pid === group.pid);
        const children = census.processes.filter(member => member.parent === group.pid);
        if (!root || !group.startTicks || !group.targetExecutable || children.length !== 1) continue;
        const row: ResidentQuietTerminal = { executionId: scope.executionId, generation: scope.generation,
          supervisor: { pid: root.pid, startToken: group.startTicks },
          shell: { pid: children[0]!.pid, startToken: children[0]!.startToken },
          targetExecutable: group.targetExecutable, noRecentInput: true };
        if (this.quietTerminal(row, this.custody.controller, census)) rows.push(row);
      }
    }
    return rows;
  }
  classifyWorkloads(request: ResidentWorkloadCensusRequest, authority: ResidentWorkloadAuthority): ResidentWorkloadClassification {
    if (!this.custody) throw new Error("cloud workload classification requires original kernel custody");
    const parsedRequest = ResidentWorkloadCensusRequestSchema.parse(request);
    const parsedAuthority = ResidentWorkloadAuthoritySchema.parse(authority);
    const census = this.custody.inspect(), snapshot = this.snapshot();
    const matching = census.complete && census.censusSha256 === parsedRequest.censusSha256 &&
      JSON.stringify(census.common) === JSON.stringify(parsedRequest.common);
    const rows = matching ? this.quietTerminals(census) : [];
    const complete = matching && snapshot.complete && rows.length <= 32;
    return ResidentWorkloadClassificationSchema.parse({ ...parsedRequest, authority: parsedAuthority,
      owner: { pid: this.custody.controller.pid, startToken: this.custody.controller.startToken },
      complete, pendingLaunches: snapshot.pendingLaunches, failedRetirements: snapshot.failedRetirements,
      quietTerminals: complete ? rows : [] });
  }
  private infrastructureScopes(census: CloudWorkloadCensus): { complete: boolean; pids: Set<number> } {
    const pids = new Set<number>();
    if (!census.complete) return { complete: false, pids };
    const processes = new Map(census.processes.map(member => [member.pid, { ...member, startTicks: member.startToken }]));
    let complete = true;
    for (const scope of this.scopes) {
      if (scope.role !== "infrastructure" || scope.state !== "active" || scope.signal.aborted || !scope.prepared) continue;
      // Role alone grants no PID exemption: retain the original Host group
      // birth and descendants, including workers that changed job groups.
      const owned = this.members(scope, processes, true);
      if (!owned.complete || owned.groups.some(group => !group.startTicks)) { complete = false; continue; }
      for (const member of owned.members) {
        if (processes.get(member.pid)?.uid !== 10003) { complete = false; continue; }
        pids.add(member.pid);
      }
    }
    return { complete, pids };
  }
  private async inspectCustody(): Promise<CloudOwnedWorkloadInspection> {
    const custody = this.custody!, before = this.snapshot(), census = custody.inspect();
    let complete = before.complete && census.complete;
    let pendingLaunches = before.pendingLaunches, failedRetirements = before.failedRetirements;
    const rows: { row: ResidentQuietTerminal; owner: ResidentWorkloadBirth }[] = this.quietTerminals(census)
      .map(row => ({ row, owner: custody.controller }));
    const channels = [...this.owners];
    if (census.complete && census.censusSha256) for (const channel of channels) {
      const present = census.processes.find(member => member.pid === channel.owner.pid && member.startToken === channel.owner.startToken);
      if (!present) continue;
      try {
        channel.assertLive();
        const request: ResidentWorkloadCensusRequest = { version: 1, requestId: randomUUID(),
          censusSha256: census.censusSha256, common: census.common };
        const reply = await channel.classifyWorkloads(request);
        channel.assertLive();
        if (!this.owners.has(channel) || !residentWorkloadClassificationMatchesRequest(reply, request, channel.authority) ||
          reply.owner.pid !== channel.owner.pid || reply.owner.startToken !== channel.owner.startToken ||
          !census.infrastructurePids.includes(channel.owner.pid)) throw new Error("cloud owner classification is stale");
        pendingLaunches += reply.pendingLaunches; failedRetirements += reply.failedRetirements;
        if (!reply.complete || reply.pendingLaunches || reply.failedRetirements) { complete = false; continue; }
        rows.push(...reply.quietTerminals.map(row => ({ row, owner: channel.owner })));
      } catch { complete = false; }
    }
    const current = custody.inspect(), after = this.snapshot();
    complete &&= current.complete && current.censusSha256 === census.censusSha256 &&
      JSON.stringify(after) === JSON.stringify(before) && channels.length === this.owners.size && channels.every(channel => this.owners.has(channel));
    // Local recent-input predicates are sampled again after remote awaits.
    const local = this.quietTerminals(current);
    const scopedInfrastructure = this.infrastructureScopes(current);
    complete &&= scopedInfrastructure.complete;
    const infrastructure = new Set([...current.infrastructurePids, ...scopedInfrastructure.pids]);
    const transport = this.originalPtyHost(current);
    if (transport !== null) infrastructure.add(transport);
    const quiet = new Set<number>(), conflicts = new Set<number>();
    for (const { row, owner } of rows) {
      if (owner.pid === custody.controller.pid && !local.some(candidate => JSON.stringify(candidate) === JSON.stringify(row))) continue;
      if (!this.quietTerminal(row, owner, current)) continue;
      if ([row.supervisor.pid, row.shell.pid].some(pid => quiet.has(pid) || infrastructure.has(pid))) {
        conflicts.add(row.supervisor.pid); conflicts.add(row.shell.pid); complete = false; continue;
      }
      quiet.add(row.supervisor.pid); quiet.add(row.shell.pid);
    }
    for (const pid of conflicts) quiet.delete(pid);
    return { complete, pendingLaunches: Math.max(pendingLaunches, after.pendingLaunches),
      failedRetirements: Math.max(failedRetirements, after.failedRetirements),
      workloadPids: current.workloadPids.filter(pid => !quiet.has(pid) && !infrastructure.has(pid)),
      infrastructurePids: [...infrastructure].sort((a, b) => a - b),
      quietTerminalPids: [...quiet].sort((a, b) => a - b), censusSha256: current.censusSha256 };
  }
  async inspect(): Promise<CloudOwnedWorkloadInspection> {
    if (this.custody) return this.inspectCustody();
    const snapshot = this.snapshot();
    let complete = snapshot.complete;
    const workloadPids: number[] = [], infrastructurePids: number[] = [];
    if ([...this.scopes].some((scope) => scope.observed.size || scope.prepared && hostOwnedLifecycleSnapshot(scope.prepared)?.groups.length)) {
      try {
        const processes = await kernelProcesses();
        for (const scope of this.scopes) {
          const owned = this.members(scope, processes); complete &&= owned.complete;
          const exempt = new Set<number>();
          for (const group of owned.groups) {
            const root = owned.members.find((member) => member.pid === group.pid);
            const children = owned.members.filter((member) => member.parent === group.pid);
            if (!root || children.length !== 1) continue;
            const child = children[0]!;
            let terminalIdle = false;
            try {
              const result = scope.kind === "terminal" ? scope.terminalIdle?.() : false;
              terminalIdle = result === true;
              if (result && typeof result === "object") void Promise.resolve(result).catch(() => undefined);
            } catch { /* no idle proof */ }
            let originalExecutable = false;
            if (terminalIdle && group.targetExecutable) {
              try {
                // PID/start-token/session survive exec. Idle requires the
                // executable captured from the ORIGINAL launch, not a name or
                // a first-observed process after shell replacement.
                const executable = await stat(`/proc/${child.pid}/exe`, { bigint: true });
                originalExecutable = executable.isFile() && String(executable.dev) === group.targetExecutable.dev &&
                  String(executable.ino) === group.targetExecutable.ino;
              } catch { /* unknown executable remains work */ }
            }
            const quietTerminal = terminalIdle && originalExecutable && child.state === "S" && child.tty !== 0 && child.foreground === child.group &&
              child.session === root.session && owned.members.length === 2;
            if (scope.role === "infrastructure" || quietTerminal) { exempt.add(root.pid); exempt.add(child.pid); }
          }
          for (const member of owned.members)
            (exempt.has(member.pid) ? infrastructurePids : workloadPids).push(member.pid);
        }
      } catch { complete = false; }
    }
    // An await may have overlapped a new prepare/retirement. Such a view cannot
    // prove emptiness; final drain fences all producers before calling inspect.
    const current = this.snapshot();
    if (JSON.stringify(current) !== JSON.stringify(snapshot)) complete = false;
    return { complete, pendingLaunches: current.pendingLaunches, failedRetirements: current.failedRetirements,
      workloadPids: workloadPids.sort((a, b) => a - b), infrastructurePids: infrastructurePids.sort((a, b) => a - b) };
  }
  async prepare(host: HostExecutionBoundary, request: BoundaryRequest, control: AdmissionControl | undefined,
    metadata: { kind: CloudWorkloadKind; role: CloudWorkloadRole; terminalIdle?: () => unknown }): Promise<PreparedBoundary> {
    this.assertAccepting();
    if (metadata.terminalIdle && (metadata.kind !== "terminal" || metadata.role !== "workload"))
      throw new Error("only an original human terminal can supply an idle proof");
    if (!(host instanceof HostExecutionBoundary)) throw new Error("cloud workload must use the Host supervisor");
    if (this.custody && hostCloudWorkloadCustody(host) !== this.custody)
      throw new Error("cloud workload must enter its original shared kernel custody");
    if (this.scopes.size + this.failedPreparations.size >= this.maxScopes) { this.overflow = true; throw new Error("cloud workload inventory capacity exceeded"); }
    if (this.failedPreparations.has(request.executionId) || [...this.scopes].some((scope) => scope.executionId === request.executionId))
      throw new Error("cloud workload execution is already owned");
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
    const controller = new AbortController();
    const signal = control?.signal ? AbortSignal.any([control.signal, controller.signal]) : controller.signal;
    const scope: Scope = { ...metadata, executionId: request.executionId, generation: `preparing-${randomUUID()}` as TerritoryGeneration,
      state: "preparing", host, controller, signal, ready, resolveReady, observed: new Map() };
    this.scopes.add(scope);
    try {
      scope.prepared = await host.prepare(request, { ...control, signal, retainFailedPreparationProof: true });
      scope.generation = scope.prepared.generation;
      scope.state = "active";
      this.assertScope(scope);
      const original = scope.prepared;
      const cloud: PreparedBoundary = {
        ...original,
        status: { ...original.status, state: "ready", backend: "cloud-worker", designProtection: { ...original.status.designProtection, enforced: false } },
        wrapSpawn: (input) => { this.assertScope(scope); return original.wrapSpawn(input); },
        spawn: async (input) => { this.assertScope(scope); return original.spawn(input); },
        trackProcess: (child) => {
          if (!hostOwnedLifecycleSnapshot(original)?.pendingLaunches) throw new Error("cloud process has no original pending Host launch");
          return original.trackProcess(child);
        },
        trackProcessGroup: (pid, options) => {
          if (!hostOwnedLifecycleSnapshot(original)?.pendingLaunches) throw new Error("cloud group has no original pending Host launch");
          return original.trackProcessGroup(pid, options);
        },
        revoke: async () => { scope.state = "stopping"; scope.controller.abort(); await original.revoke(); },
        stopAndProve: () => this.retire(scope),
      };
      originalScopes.set(cloud, { registry: this, scope });
      return cloud;
    } catch (error) {
      scope.state = "failed";
      if (control?.retainFailedPreparationProof) this.failedPreparations.set(request.executionId, { scope, proved: false });
      try { await this.retire(scope); }
      catch (proof) { throw new AggregateError([error, proof], "cloud preparation retirement failed"); }
      throw error;
    } finally { scope.resolveReady(); }
  }
  async proveFailedPreparationStopped(host: HostExecutionBoundary, executionId: string): Promise<void> {
    const receipt = this.failedPreparations.get(executionId);
    if (!receipt || receipt.scope.host !== host)
      throw new Error("Only an exact opted-in rejected cloud preparation can be proven here.");
    if (receipt.consuming) return receipt.consuming;
    const proof = Promise.resolve().then(async () => {
      await receipt.scope.ready;
      if (!receipt.proved) await this.retire(receipt.scope);
      if (!receipt.proved || this.scopes.has(receipt.scope)) throw new Error("cloud preparation cleanup is not proven");
      if (this.failedPreparations.get(executionId) === receipt) this.failedPreparations.delete(executionId);
    });
    receipt.consuming = proof;
    try { await proof; }
    finally { if (receipt.consuming === proof) receipt.consuming = undefined; }
  }
  private retire(scope: Scope): Promise<void> {
    if (!this.scopes.has(scope)) return Promise.resolve();
    if (scope.stopping) return scope.stopping;
    scope.state = "stopping"; scope.controller.abort();
    const attempt = Promise.resolve().then(async () => {
      if (!this.custody && scope.prepared && (scope.observed.size || hostOwnedLifecycleSnapshot(scope.prepared)?.groups.length)) {
        if (!this.members(scope, await kernelProcesses()).complete) throw new Error("cloud descendant ownership is unproven");
      }
      if (scope.prepared) await scope.prepared.stopAndProve();
      else await scope.host.proveFailedPreparationStopped(scope.executionId);
      if (!this.custody && scope.observed.size) {
        const remaining = this.members(scope, await kernelProcesses());
        if (!remaining.complete || remaining.members.length) throw new Error("cloud owned descendants have not retired");
      }
      this.scopes.delete(scope);
      const receipt = this.failedPreparations.get(scope.executionId);
      if (receipt?.scope === scope) receipt.proved = true;
    });
    scope.stopping = attempt.catch((error) => { scope.state = "failed"; scope.stopping = undefined; throw error; });
    return scope.stopping;
  }
}
