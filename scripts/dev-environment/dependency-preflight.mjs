import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export const CONTROL_PLANE_INSTALL = "pnpm --dir apps/control-plane install --frozen-lockfile";
const messages = Object.freeze({
  control_plane_dependencies_missing: `Control-plane dependencies are missing. Run ${CONTROL_PLANE_INSTALL} from the checkout root.`,
  control_plane_dependencies_unavailable: `Control-plane dependencies could not load. Repair them with ${CONTROL_PLANE_INSTALL}.`,
  gc_unavailable: "Dev operation is unconfirmed; existing state was preserved.",
});
export class DevEnvironmentError extends Error {
  constructor(code) {
    const safe = Object.hasOwn(messages, code) ? code : "gc_unavailable";
    super(messages[safe]); this.code = safe;
  }
}
export function devEnvironmentDiagnostic(error) {
  const code = error instanceof DevEnvironmentError && Object.hasOwn(messages, error.code) ? error.code : "gc_unavailable";
  return { code, message: messages[code], ...(["control_plane_dependencies_missing", "control_plane_dependencies_unavailable"].includes(code)
    ? { command: CONTROL_PLANE_INSTALL } : {}) };
}
export function devEnvironmentFailure(error, fallback) {
  return error instanceof DevEnvironmentError ? error : new DevEnvironmentError(fallback);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const allowed = new Set(["@aws-sdk/client-s3", "pg"]);
/** Resolve at the independent install root. A root pnpm install does not
 * hydrate this graph, and loader exceptions can contain private paths/data. */
export function loadControlPlaneDependency(name, repositoryRoot = root) {
  if (!allowed.has(name)) throw new DevEnvironmentError("control_plane_dependencies_unavailable");
  try { return createRequire(path.join(repositoryRoot, "apps/control-plane/package.json"))(name); }
  catch (error) {
    throw new DevEnvironmentError(["MODULE_NOT_FOUND", "ERR_MODULE_NOT_FOUND"].includes(error?.code)
      ? "control_plane_dependencies_missing" : "control_plane_dependencies_unavailable");
  }
}
export function checkControlPlaneDependencies(repositoryRoot = root) {
  for (const name of allowed) loadControlPlaneDependency(name, repositoryRoot);
}
