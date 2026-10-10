import path from "node:path";
import { enterCloudWorkload } from "./cloud-workload-cgroup.mjs";

const MAX_BYTES = 16 * 1024;
const MAX_U64 = 18446744073709551615n;
const unavailable = () => Object.assign(new Error("Cloud workload entry is unavailable."), {
  code: "cloud_containment_environment_not_ready",
});
const exact = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
const identity = value => typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.exec(value)?.[0] === value && BigInt(value) <= MAX_U64;
const directory = value => typeof value === "string" && value.length <= 4096 &&
  !/[\0\r\n]/.test(value) && path.posix.isAbsolute(value) && path.posix.normalize(value) === value;
const location = value => exact(value, ["directory", "dev", "ino"]) && directory(value.directory) && identity(value.dev) && identity(value.ino);

/** A bounded internal courier, not placement authority. The kernel helper
 * rechecks the root-owned projection and original inode/source evidence,
 * self-enters with the current non-root identity, closes its FD and rereads
 * actual membership. No provider environment or root-open FD is accepted. */
export function enterCloudHostWorkload(encoded, io) {
  try {
    if (typeof encoded !== "string" || encoded.length === 0 || encoded.length > Math.ceil(MAX_BYTES * 4 / 3) ||
      !/^[A-Za-z0-9_-]+$/.test(encoded)) throw unavailable();
    const bytes = Buffer.from(encoded, "base64url");
    const source = bytes.toString("utf8");
    if (bytes.length > MAX_BYTES || bytes.toString("base64url") !== encoded || !Buffer.from(source, "utf8").equals(bytes)) throw unavailable();
    const entry = JSON.parse(source);
    if (!exact(entry, ["version", "common", "workload"]) || entry.version !== 1 ||
      !location(entry.common) || !location(entry.workload) || !entry.common.directory.endsWith("/engine-runtime") ||
      entry.workload.directory !== `${entry.common.directory}/engine-workload-shared/workload`) throw unavailable();
    Object.freeze(entry.common); Object.freeze(entry.workload); Object.freeze(entry);
    // Treat the dependency result as unknown at this pre-exec boundary: an
    // accidental Promise must still fail closed despite its declared void.
    /** @type {unknown} */
    const result = enterCloudWorkload(entry, io);
    if (result !== undefined) {
      // An asynchronous helper cannot satisfy a before-target-entry contract.
      // Contain its rejection while refusing this launch; never await and run.
      if (result !== null && (typeof result === "object" || typeof result === "function") && typeof result.then === "function") {
        void Promise.resolve(result).catch(() => {});
      }
      throw unavailable();
    }
  } catch { throw unavailable(); }
}
