export const CLOUD_GIT_EXEC_ROOT: string;
export function cloudRuntimeAssetEnvironment(runtime: { profile: string; workerRoot: string; runtimeId?: string }): Record<string, string>;
export function runtimeSystemAssetFiles(value: unknown): string[];
