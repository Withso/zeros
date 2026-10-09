export interface CloudWorkloadDirectoryIdentity {
  readonly directory: string; readonly dev: string; readonly ino: string;
}
export interface CloudWorkloadKernelMetadata {
  readonly dev: string; readonly ino: string; readonly uid: number; readonly mode: number; readonly filesystem: number;
}
export interface CloudWorkloadKernelProcess {
  readonly pid: number; readonly parent: number; readonly group: number; readonly session: number;
  readonly tty: number; readonly foreground: number; readonly state: string; readonly startToken: string;
  readonly directory: string; readonly uid: number; readonly executable: {readonly dev: string; readonly ino: string} | null;
}
export interface CloudWorkloadKernelIO {
  identity(): {pid: number; uid: number; gid: number; euid: number; egid: number};
  projection(): string;
  directory(directory: string): CloudWorkloadKernelMetadata;
  control(directory: string, name: string): CloudWorkloadKernelMetadata;
  read(directory: string, name: string): string;
  children(directory: string): string[];
  process(pid: number): CloudWorkloadKernelProcess | null;
  writeSelf(directory: string): void;
}
export interface CloudWorkloadEntry {
  readonly version: 1; readonly common: CloudWorkloadDirectoryIdentity; readonly workload: CloudWorkloadDirectoryIdentity;
}
export interface CloudDelegatedWorkloadEvidence extends CloudWorkloadEntry {
  readonly infrastructure: readonly {readonly kind: "engine" | "resident"; readonly pid: number;
    readonly startToken: string; readonly controlDirectory: string | null;
    readonly controlIdentity: CloudWorkloadDirectoryIdentity | null}[];
  readonly cpuSplit: unknown;
}
export interface CloudWorkloadCensus {
  readonly complete: boolean; readonly populated: boolean; readonly processes: readonly CloudWorkloadKernelProcess[];
  readonly workloadPids: readonly number[]; readonly infrastructurePids: readonly number[];
  readonly common: CloudWorkloadDirectoryIdentity; readonly groups: number;
  readonly censusSha256: string | null;
}
export const nativeCloudWorkloadIO: CloudWorkloadKernelIO;
export function loadCloudWorkloadCustody(root: string, io?: CloudWorkloadKernelIO): CloudDelegatedWorkloadEvidence;
export function cloudWorkloadEntryDescriptor(custody: CloudDelegatedWorkloadEvidence): CloudWorkloadEntry;
export function enterCloudWorkload(entry: CloudWorkloadEntry, io?: CloudWorkloadKernelIO): void;
export function inspectCloudWorkloadTree(custody: CloudDelegatedWorkloadEvidence, io?: CloudWorkloadKernelIO): CloudWorkloadCensus;
