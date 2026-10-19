import type { Stats } from "node:fs";
export const CLOUD_RUNNER_BASE: string;
export function cloudRunnerBaseSupported(filesystem?: {
  openSync(file: string, flags: number): number;
  fstatSync(fd: number): Pick<Stats, "isFile" | "isDirectory" | "uid" | "mode" | "nlink" | "size">;
  readFileSync(fd: number, encoding: string): string;
  readdirSync(file: string): string[];
  realpathSync(file: string): string;
  closeSync(fd: number): void;
}): boolean;
export function cloudRunnerQualificationPassed(value: unknown): boolean;
