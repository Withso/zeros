import type { SpawnOptions } from "node:child_process";
import type { Readable } from "node:stream";
export function runnerTransportArguments(values: readonly string[]): { command: string; values: string[] };
export function runCloudRunnerTransport(options: { input: Readable; args: readonly string[]; timeoutMs?: number;
  spawnProcess?: (command: string, args: string[], options: SpawnOptions) => {
    once(event: "error", listener: (error: Error) => void): unknown;
    once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  } }): Promise<number>;
