import type * as fs from "node:fs";

export interface CloudActiveRuntime {
  readonly schema: "zeros.active-runtime/v1";
  readonly runtimeId: string;
  readonly manifestSha256: string;
  readonly root: string;
  readonly baseCompatibilityId: string;
  readonly installerReceiptSha256: string;
  readonly bootId: string;
  readonly supervisorSessionId: string;
  readonly cgroupRoot: string;
}
interface CloudRuntimePaths {
  readonly root: string;
  readonly workerRoot: string;
  readonly libRoot: string;
  readonly binRoot: string;
  readonly node: string;
  readonly startEngine: string;
  readonly processSupervisor: string;
  readonly engineNamespace: string;
  readonly cgroupRoot: string;
  readonly helpers: Readonly<Record<"setup" | "attester" | "supervisor" | "ensureSupervisor" | "launcher" |
    "setupProcess" | "profile" | "consumeAdmission" | "gitAskpass" | "installPreviewLinks" |
    "installGithubCredential" | "githubRefreshRequest", string>>;
}
export type CloudRuntimeRoot = Readonly<CloudRuntimePaths & CloudActiveRuntime & { profile: "v4" }>;
export interface CloudRuntimeResolver {
  resolve(): CloudRuntimeRoot;
  resolveChild(): Readonly<Omit<CloudRuntimePaths, "cgroupRoot"> & { profile: "v4"; runtimeId: string }>;
  assertPath(file: string, directory?: boolean): void;
  assertChildPath(file: string, directory?: boolean): void;
  packagePath(file: string): string;
}
export function createCloudRuntimeResolver(options?: {
  filesystem?: {
    lstatSync(file: string): fs.Stats;
    realpathSync(file: string): string;
    readlinkSync(file: string): string;
    openSync(file: string, flags: number): number;
    fstatSync(fd: number): fs.Stats;
    readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number | null): number;
    closeSync(fd: number): void;
  };
  isOwner?: (file: string, uid: number) => boolean;
  isReadOnly?: (file: string) => boolean;
  isEngine?: () => boolean;
  executable?: () => string;
}): CloudRuntimeResolver;
export function resolveCloudRuntime(): CloudRuntimeRoot;
export function resolveCloudRuntimeChild(): ReturnType<CloudRuntimeResolver["resolveChild"]>;
export function assertCloudRuntimePath(file: string, directory?: boolean): void;
export function assertCloudRuntimeChildPath(file: string, directory?: boolean): void;
export function resolveCloudRuntimePackagePath(file: string): string;
export function parseCloudActiveRuntime(value: unknown): CloudActiveRuntime;
export function cloudActiveRuntimeDescriptor(runtime: CloudRuntimeRoot): CloudActiveRuntime;
export function validateCloudRuntimeMarker(value: unknown, projection?: boolean): unknown;
export function isCloudRuntimeCgroupRoot(value: unknown): boolean;
export function cloudProfileIdentityMapVersion(version: number): 5 | null;
export function isCloudEngineIdMap(source: unknown): boolean;
export function cloudEngineIdMapVersion(source: unknown): 2 | 3 | 4 | 5 | null;
export function hasCloudEngineUserNamespace(version?: 4): boolean;
export function isCloudEngineSecurityStatus(source: unknown): boolean;
export function isReadOnlyCloudMount(candidate: string, source: string): boolean;
export function isCloudDeploymentOwner(candidate: string, uid: number): boolean;
