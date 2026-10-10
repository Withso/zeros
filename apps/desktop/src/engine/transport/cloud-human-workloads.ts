import type {ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {StringDecoder} from 'node:string_decoder';
import type {CloudExecutionBoundary} from '../agents/containment/cloud-execution-boundary';
import type {PreparedBoundary} from '../agents/containment/types';
import {spawnPtyViaHost} from '../pty/pty-host-client';
import type {PtyHandle} from '../pty/service';

interface Owner {
  ready: Promise<PreparedBoundary>;
  scope?: PreparedBoundary;
  stopping?: Promise<void>;
  closeNative?: () => void;
}
/** Each SSH channel owns its own registered Host group. A helper's group is
 * never used as proof for a PTY created in a different session. */
export class CloudHumanWorkloads {
  private closed = false;
  private readonly owners = new Set<Owner>();
  constructor(private readonly boundary: Pick<CloudExecutionBoundary,'prepareOwned'>,
    private readonly workspaceRoot: string, private readonly failed: () => void = () => {}) {}
  hasActiveWork(): boolean { return this.owners.size > 0; }
  private async prepare(cwd: string): Promise<Owner> {
    if (this.closed || this.owners.size >= 32) throw new Error('Cloud SSH lifecycle is unavailable');
    const owner: Owner = {ready: this.boundary.prepareOwned({executionId:`human-ssh-${randomUUID()}`,
      actor:'repo-code-task',providerId:'human-ssh',cwd,workspaceRoot:this.workspaceRoot},{kind:'ssh',role:'workload'})};
    this.owners.add(owner);
    try {
      owner.scope = await owner.ready;
      if (this.closed) throw new Error('Cloud SSH lifecycle is unavailable');
      return owner;
    } catch (error) {
      await this.retire(owner); throw error;
    }
  }
  private retire(owner: Owner): Promise<void> {
    if (!this.owners.has(owner)) return Promise.resolve();
    if (owner.stopping) return owner.stopping;
    owner.closeNative?.();
    const stop = Promise.resolve().then(async () => {
      const scope = owner.scope ?? await owner.ready;
      await scope.stopAndProve(); this.owners.delete(owner);
    }).catch(error => {owner.stopping = undefined; this.failed(); throw error;});
    owner.stopping = stop; return stop;
  }
  private retired(owner: Owner): void { void this.retire(owner).catch(() => {}); }
  async spawnProcess(command: string,args: readonly string[],options: {cwd: string;env: Readonly<Record<string,string>>}): Promise<ChildProcess> {
    const owner = await this.prepare(options.cwd);
    try {
      if (this.closed) throw new Error('Cloud SSH lifecycle is unavailable');
      const process = await owner.scope!.spawn({command,args,cwd:options.cwd,env:options.env,stdio:'pipe'});
      const child = process.child;
      if (!child?.stdin || !child.stdout || !child.stderr) throw new Error('Cloud SSH process pipes are unavailable');
      child.kill = (signal = 'SIGTERM') => {
        if (typeof signal !== 'string') return false;
        void process.signal(signal).catch(() => {this.failed();}); return true;
      };
      child.once('close',()=>this.retired(owner));
      if (this.closed) throw new Error('Cloud SSH lifecycle is unavailable');
      return child;
    } catch(error) {await this.retire(owner); throw error;}
  }
  async spawnPty(command: string,args: readonly string[],options: {cwd:string;env: Readonly<Record<string,string>>;cols?:number;rows?:number;name?:string}) {
    const owner = await this.prepare(options.cwd);
    let handle: PtyHandle|undefined, exited = false;
    try {
      if (this.closed) throw new Error('Cloud SSH lifecycle is unavailable');
      const scope = owner.scope!;
      const launch = scope.wrapSpawn({command,args,cwd:options.cwd,env:options.env,stdio:'inherit'});
      try {
        handle = spawnPtyViaHost({shell:launch.command,args:[...launch.args],cwd:launch.cwd,env:{...launch.env},
          cols:options.cols ?? 80,rows:options.rows ?? 24,name:options.name,
          ...(launch.immediateParentPidArgIndex === undefined ? {} : {immediateParentPidArgIndex:launch.immediateParentPidArgIndex})});
      } catch(error) {scope.cancelUnstartedLaunch?.(launch);throw error;}
      const terminal = handle;
      owner.closeNative = () => terminal.kill();
      terminal.onSpawned(pid => {
        try {scope.trackProcessGroup(pid,{leaderExited:()=>exited});}
        catch {this.failed();this.retired(owner);}
      });
      terminal.onExit((_code,_signal,reason) => {
        exited = true;
        if (!terminal.pid && (reason === 'spawn-failed' || reason === 'host-unavailable')) {
          try {scope.cancelUnstartedLaunch?.(launch);} catch {this.failed();}
        }
        this.retired(owner);
      });
      if (this.closed) throw new Error('Cloud SSH lifecycle is unavailable');
      const decoder = new StringDecoder("utf8");
      return {
        write: (data: string|Buffer) => {const text = typeof data === "string" ? data : decoder.write(data);if(text)terminal.write(text);},
        resize: (cols:number,rows:number) => terminal.resize(cols,rows),
        kill: (_signal?:string) => this.retired(owner),
        // The shared PTY transport has bounded output and no pause RPC. The
        // SSH channel's existing one-MiB limit closes an overloaded stream.
        pause() {},resume() {},
        onData: (callback:(data:string)=>void) => terminal.onData(callback),
        onExit: (callback:(event:{exitCode:number})=>void) => terminal.onExit(code=>callback({exitCode:code ?? 1})),
      };
    } catch(error) {await this.retire(owner);throw error;}
  }
  async close(): Promise<void> {
    this.closed = true;
    const results = await Promise.allSettled([...this.owners].map(owner=>this.retire(owner)));
    const failures = results.flatMap(result=>result.status === 'rejected' ? [result.reason] : []);
    if (failures.length) throw failures.length === 1 ? failures[0] : new AggregateError(failures,'Cloud SSH retirement failed');
  }
}
