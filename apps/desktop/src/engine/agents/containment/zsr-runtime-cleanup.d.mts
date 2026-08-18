export interface ZsrCleanupOptions {
  readonly portPolicyControl?: {
    close(): Promise<void>;
  };
  readonly sandboxManager?: {
    cleanupAfterCommand(): void;
    reset(): Promise<void>;
  };
  readonly cgroupScope: unknown;
  readonly killCgroup: (scope: unknown) => Promise<void>;
}

export function cleanupZsrRuntime(options: ZsrCleanupOptions): Promise<void>;

export function withZsrRuntimeCleanup<T>(
  options: ZsrCleanupOptions,
  action: () => Promise<T>,
): Promise<T>;
