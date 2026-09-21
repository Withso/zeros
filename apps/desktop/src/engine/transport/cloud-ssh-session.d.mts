import type { Duplex } from 'node:stream';
import type { spawn } from 'node:child_process';
import type { IPty, IPtyForkOptions } from 'node-pty';
export function assertCloudSshWorkerIdentity(status: string, identity: {
  platform: string; uid: number; gid: number; groups: number[];
}): void;
export function createCloudSshSession(stream: Duplex, options: {
  cwd: string;
  env: Record<string, string>;
  sftpServer?: string;
  spawnPty?: (command: string, args: string[], options: IPtyForkOptions) => IPty;
  spawnProcess?: typeof spawn;
}): { publicKey: string; hostKeySha256: string; start(): void; close(): void };
