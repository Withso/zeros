import { GitError } from "../git";

export type Params = Record<string, unknown>;

export function reqStr(p: Params, key: string): string {
  const v = p[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: `missing required string '${key}'`,
    });
  }
  return v;
}
export function reqNum(p: Params, key: string): number {
  const v = p[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: `missing required number '${key}'`,
    });
  }
  return v;
}
export const optStr = (p: Params, k: string): string | undefined =>
  typeof p[k] === "string" && (p[k] as string).length > 0
    ? (p[k] as string)
    : undefined;

export const optStrArr = (p: Params, k: string): string[] | undefined => {
  const v = p[k];
  if (!Array.isArray(v)) return undefined;
  const arr = v.filter((x): x is string => typeof x === "string");
  return arr.length > 0 ? arr : undefined;
};
export const optNum = (p: Params, k: string): number | undefined =>
  typeof p[k] === "number" && Number.isFinite(p[k] as number)
    ? (p[k] as number)
    : undefined;
export const optBool = (p: Params, k: string): boolean | undefined =>
  typeof p[k] === "boolean" ? (p[k] as boolean) : undefined;
