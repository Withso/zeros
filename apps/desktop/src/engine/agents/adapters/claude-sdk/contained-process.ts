import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Writable } from "node:stream";
import { isUtf8 } from "node:buffer";
import { CloudCommandFailureError } from "@zeros/protocol/cloud-commands";

import type {
  SpawnedProcess,
  SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  BoundaryProcess,
  PreparedBoundary,
} from "../../containment/types";

const NATIVE_INPUT_OBSERVATION_MAX_BYTES = 2 * 1024 * 1024;
const NATIVE_INPUT_HANDOFF_MAX_BYTES = 64 * 1024 * 1024;
/** Authority is synchronous and precedes the irreversible transport write.
 * It is separate from passive R7 observations, including when those are off.
 * The pinned SDK writes one complete UTF-8 JSON line per transport call. */
export function guardClaudeUserMessageWrites(input:Writable,beforeWrite:(uuid:string)=>void):void{
  const write=input.write;
  const refused=()=>new CloudCommandFailureError({stage:"validation",category:"access_denied"});
  input.write=function(this:Writable,...args:unknown[]):boolean{
    const chunk=args[0];let encoded:string;
    if(typeof chunk==="string"){
      if(typeof args[1]==="string"&&!["utf8","utf-8"].includes(args[1]))throw refused();
      if(Buffer.byteLength(chunk,"utf8")>NATIVE_INPUT_HANDOFF_MAX_BYTES)throw refused();
      encoded=chunk;
    }else if(chunk instanceof Uint8Array){
      if(chunk.byteLength>NATIVE_INPUT_HANDOFF_MAX_BYTES||!isUtf8(chunk))throw refused();
      encoded=Buffer.from(chunk.buffer,chunk.byteOffset,chunk.byteLength).toString("utf8");
    }else throw refused();
    if(!encoded.endsWith("\n"))throw refused();
    let frame:unknown;
    try{frame=JSON.parse(encoded);}catch{throw refused();}
    if(!frame||typeof frame!=="object"||!("type" in frame)||typeof frame.type!=="string")throw refused();
    if(frame.type==="user"){
      if(!("uuid" in frame)||typeof frame.uuid!=="string"||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(frame.uuid))throw refused();
      const result:unknown=beforeWrite(frame.uuid);
      if(result!==undefined){void Promise.resolve(result).catch(()=>{});throw refused();}
    }
    return Reflect.apply(write,this,args) as boolean;
  } as Writable["write"];
}
/** Passive observation of the actual SDK stdin.write call. A successful
 * write may still be buffered; only a later native command receipt proves
 * acceptance. Complete bounded user frames provide their UUID only, with
 * no payload retention. Unobserved/fragmented input never fabricates timing. */
export function observeClaudeUserMessageWrites(
  input: Writable, onWritten: (uuid: string) => void, active: () => boolean = () => true,
): void {
  const write = input.write;
  input.write = function(this: Writable, ...args: unknown[]): boolean {
    const result = Reflect.apply(write, this, args) as boolean;
    try {
      if (!active()) return result;
      const chunk = args[0]; let encoded: string;
      if (typeof chunk === "string") {
        if (typeof args[1] === "string" && !["utf8", "utf-8"].includes(args[1])) return result;
        if (Buffer.byteLength(chunk, "utf8") > NATIVE_INPUT_OBSERVATION_MAX_BYTES) return result;
        encoded = chunk;
      } else if (chunk instanceof Uint8Array) {
        if (chunk.byteLength > NATIVE_INPUT_OBSERVATION_MAX_BYTES) return result;
        encoded = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString("utf8");
      } else return result;
      if (!encoded.endsWith("\n")) return result;
      const frame: unknown = JSON.parse(encoded);
      if (frame && typeof frame === "object" && "type" in frame && frame.type === "user" && "uuid" in frame &&
          typeof frame.uuid === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(frame.uuid))
        void Promise.resolve(onWritten(frame.uuid)).catch(() => {});
    } catch { /* Observation cannot change write, transport or turn behavior. */ }
    return result;
  } as Writable["write"];
}

const DEFAULT_GRACE_MS = 500;
const DEFAULT_SIGNAL_WAIT_MS = 1_000;
const POLL_MS = 20;

export interface ContainedClaudeProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly processGroupId: number;
  readonly exited: Promise<void>;
  readonly boundaryProcess?: BoundaryProcess;
  termination: Promise<void> | null;
}

function processGroupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

function signalProcessGroup(
  processGroupId: number,
  signal: NodeJS.Signals,
): void {
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function waitForProcessGroupExit(
  processGroupId: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(processGroupId)) {
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_MS));
  }
  return true;
}

/** Spawn a territory-bound Claude CLI as a dedicated POSIX process group.
 *
 * The SDK normally owns its child handle privately. That makes `query.close()`
 * unable to prove teardown to Zeros while a workspace's immutable filesystem
 * authority is changing. The custom SDK spawn seam preserves the same pipes
 * and environment while retaining one observable group handle. Territory
 * admission already rejects non-macOS/Linux hosts, so falling back to an
 * unobservable Windows process tree would be a policy bypass. */
export function spawnContainedClaudeProcess(
  options: SpawnOptions,
  callbacks: {
    onSpawn(process: ContainedClaudeProcess): void;
    onStderr(data: string): void;
    onUserMessageWrite?(uuid: string): void;
    beforeUserMessageWrite?(uuid:string):void;
    isUserMessageObservationActive?(): boolean;
  },
  executionBoundary?: PreparedBoundary,
): SpawnedProcess {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error(
      `Claude process-group containment is unsupported on ${process.platform}`,
    );
  }

  const completeEnv = Object.fromEntries(
    Object.entries(options.env ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  if (executionBoundary && Object.keys(completeEnv).length === 0) {
    throw new Error(
      "a contained Claude process requires a complete environment",
    );
  }
  const launch = executionBoundary
    ? executionBoundary.wrapSpawn({
        command: options.command,
        args: options.args,
        cwd: options.cwd ?? process.cwd(),
        env: completeEnv,
        stdio: "pipe",
      })
    : undefined;
  let child:ChildProcessWithoutNullStreams;
  try{child = spawn(
    launch?.command ?? options.command,
    launch?.args ?? options.args,
    {
      cwd: launch?.cwd ?? options.cwd,
      env: launch?.env ?? options.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );}catch(error){if(launch)executionBoundary?.cancelUnstartedLaunch?.(launch);throw error;}
  child.on("error",()=>{});
  const processGroupId = child.pid;
  if (!processGroupId || processGroupId === process.pid) {
    if(!processGroupId&&launch)executionBoundary?.cancelUnstartedLaunch?.(launch);
    child.kill("SIGKILL");
    throw new Error("Claude process did not receive a dedicated process group");
  }
  const boundaryProcess = executionBoundary?.trackProcess(child);
  if (callbacks.onUserMessageWrite) observeClaudeUserMessageWrites(child.stdin, callbacks.onUserMessageWrite, callbacks.isUserMessageObservationActive);
  if(callbacks.beforeUserMessageWrite)guardClaudeUserMessageWrites(child.stdin,callbacks.beforeUserMessageWrite);

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (data: string) => callbacks.onStderr(data));

  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  const tracked: ContainedClaudeProcess = {
    child,
    processGroupId,
    exited,
    ...(boundaryProcess ? { boundaryProcess } : {}),
    termination: null,
  };
  callbacks.onSpawn(tracked);

  // This is the SDK's forwarded abort signal: it fires only after its own
  // stdin-EOF grace period. A direct Zeros teardown calls the exported stop
  // function itself, while this listener also covers SDK-internal shutdowns.
  options.signal.addEventListener(
    "abort",
    () => {
      void terminateContainedClaudeProcess(tracked, { graceMs: 0 }).catch(
        () => undefined,
      );
    },
    { once: true },
  );

  if(boundaryProcess?.requiresOwnedSignals){
    // The SDK owns transport only. Its TERM/KILL ladder must not destroy the
    // outer reaper before it can prove every private descendant has exited.
    return {
      stdin:child.stdin,stdout:child.stdout,
      get killed(){return tracked.termination!==null;},
      get exitCode(){return child.exitCode;},
      get signalCode(){return child.signalCode;},
      kill:()=>{void terminateContainedClaudeProcess(tracked,{graceMs:0}).catch(()=>{});return true;},
      on:(event,listener)=>{child.on(event,listener);},
      once:(event,listener)=>{child.once(event,listener);},
      off:(event,listener)=>{child.off(event,listener);},
    };
  }
  return child;
}

/** Stop and verify the complete process group before an old territory grant
 * can be retired. SIGTERM follows a short graceful window; SIGKILL is the
 * bounded fail-safe. A surviving group rejects teardown, which the gateway's
 * fail-closed lifecycle path propagates instead of publishing new authority. */
export function terminateContainedClaudeProcess(
  tracked: ContainedClaudeProcess,
  opts: { graceMs?: number; signalWaitMs?: number } = {},
): Promise<void> {
  if (tracked.termination) return tracked.termination;
  tracked.termination = (async () => {
    if (tracked.boundaryProcess) {
      await tracked.boundaryProcess.stopAndProve();
      return;
    }
    const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
    const signalWaitMs = opts.signalWaitMs ?? DEFAULT_SIGNAL_WAIT_MS;
    if (
      graceMs > 0 &&
      (await waitForProcessGroupExit(tracked.processGroupId, graceMs))
    ) {
      return;
    }
    if (!processGroupExists(tracked.processGroupId)) return;

    signalProcessGroup(tracked.processGroupId, "SIGTERM");
    if (await waitForProcessGroupExit(tracked.processGroupId, signalWaitMs)) {
      return;
    }

    signalProcessGroup(tracked.processGroupId, "SIGKILL");
    if (
      !(await waitForProcessGroupExit(tracked.processGroupId, signalWaitMs))
    ) {
      throw new Error(
        `Claude process group ${tracked.processGroupId} survived SIGKILL`,
      );
    }
    await tracked.exited;
  })();
  return tracked.termination;
}
