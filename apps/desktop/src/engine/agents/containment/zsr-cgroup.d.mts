export interface ZsrCgroupLimits {
  readonly memoryBytes: number;
  readonly cpuQuotaMicros: number;
  readonly cpuPeriodMicros: number;
  readonly processes: number;
}

export interface ZsrCgroupScope {
  readonly path: string;
  readonly limits: Readonly<ZsrCgroupLimits>;
}

export function createZsrCgroupScope(options: {
  readonly parent: string;
  readonly generation: string;
  readonly limits?: ZsrCgroupLimits;
  readonly onDirectoryCreatedForTesting?: (scope: string) => void;
}): ZsrCgroupScope;

export function wrapWithZsrCgroup(
  scope: { readonly path: string; readonly limits?: ZsrCgroupLimits },
  argv: readonly string[],
): string[];

export function killAndRemoveZsrCgroup(
  scope: Pick<ZsrCgroupScope, "path"> | null | undefined,
  timeoutMs?: number,
): Promise<void>;

export function recoverZsrCgroupScopes(
  parent: string | null | undefined,
): Promise<{
  readonly discovered: number;
  readonly recovered: number;
  readonly active: number;
  readonly preserved: number;
}>;
