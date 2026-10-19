import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { CloudRunnerProof } from "./cloud-runner-contract";
export function runCloudAgentRunner(options: { input: Readable; output: Writable; error: Writable;
  proof: unknown; spawnProcess?: (command: string, args: string[], options: SpawnOptions) => ChildProcess; timeoutMs?: number }): Promise<number>;
export function cloudAgentRunnerProof(args: readonly string[], env?: NodeJS.ProcessEnv): CloudRunnerProof;
