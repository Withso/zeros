export { cloudRunnerBaseSupported } from "./cloud-runner-base.mjs";
export function cloudRunnerManagerEnvironment(directory: string): Readonly<Record<string, string>>;
export function runCloudRunnerManager(args: readonly string[]): Promise<never>;
