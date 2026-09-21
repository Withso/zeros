import { closeSync, constants, statfsSync, openSync, readSync } from "node:fs";
import path from "node:path";

const PROC_SUPER_MAGIC = 0x9fa0;
const OVERFLOW_ID = 65534;

/** The fixed launcher maps only the versioned VM identities. In particular VM
 * root, the provider's login user, and supplementary groups are not mapped. */
export function cloudEngineIdMapVersion(source) {
  if (typeof source !== "string" || source.length > 256) return null;
  const rows = source.trim().split("\n");
  if (rows.length !== 2 && rows.length !== 3) return null;
  const parsed = rows.map((row) => {
    if (!/^\s*\d+\s+\d+\s+\d+\s*$/.test(row)) return null;
    return row.trim().split(/\s+/).map(Number);
  });
  if(parsed[0]?.join(",")!=="0,10003,1"||parsed[1]?.join(",")!=="10001,10001,2")return null;
  return rows.length===2?2:parsed[2]?.join(",")==="10004,10004,1"?3:null;
}

export function isCloudEngineIdMap(source) {
  return cloudEngineIdMapVersion(source)!==null;
}

function readProc(file, maximum) {
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (statfsSync(`/proc/self/fd/${descriptor}`).type !== PROC_SUPER_MAGIC)
      throw new Error("Cloud namespace evidence is not procfs");
    const buffer = Buffer.alloc(maximum + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = readSync(
        descriptor,
        buffer,
        size,
        buffer.length - size,
        null,
      );
      if (!read) break;
      size += read;
    }
    if (size > maximum)
      throw new Error("Cloud namespace evidence is too large");
    return buffer.toString("utf8", 0, size);
  } finally {
    closeSync(descriptor);
  }
}

export function hasCloudEngineUserNamespace(version) {
  if (
    process.platform !== "linux" ||
    process.getuid?.() !== 0 ||
    process.geteuid?.() !== 0 ||
    process.getgid?.() !== 0 ||
    process.getegid?.() !== 0
  )
    return false;
  try {
    const uidVersion=cloudEngineIdMapVersion(readProc("/proc/self/uid_map",256));
    const gidVersion=cloudEngineIdMapVersion(readProc("/proc/self/gid_map",256));
    return (uidVersion===2||uidVersion===3)&&uidVersion===gidVersion&&(version===undefined||uidVersion===version);
  } catch {
    return false;
  }
}

function mountPath(value) {
  // These are the only escapes in a kernel mountinfo pathname. Never accept a
  // partial or unknown escape as another spelling of an authority path.
  if (/\\(?!040|011|012|134)/.test(value)) return null;
  return value.replace(/\\(040|011|012|134)/g, (_, octal) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

export function isReadOnlyCloudMount(candidate, source) {
  if (
    typeof candidate !== "string" ||
    !path.isAbsolute(candidate) ||
    path.resolve(candidate) !== candidate ||
    candidate.includes("\0") ||
    typeof source !== "string" ||
    source.length > 2 * 1024 * 1024
  )
    return false;
  let closest = null;
  for (const line of source.trim().split("\n")) {
    const fields = line.split(" ");
    const separator = fields.indexOf("-");
    if (separator < 6 || fields.length < separator + 4) return false;
    const mount = mountPath(fields[4]);
    if (!mount || !path.isAbsolute(mount) || path.resolve(mount) !== mount)
      return false;
    if (
      candidate !== mount &&
      mount !== "/" &&
      !candidate.startsWith(`${mount}/`)
    )
      continue;
    // A stacked mount at the same pathname is ambiguous without resolving its
    // mount ID from the pinned descriptor. Fail closed for that rare case.
    if (closest?.mount === mount) return false;
    if (!closest || mount.length > closest.mount.length)
      closest = { mount, readOnly: fields[5].split(",").includes("ro") };
  }
  return closest?.readOnly === true;
}

/** The host launcher attests physical root ownership BEFORE entering the
 * namespace and locks these mounts by crossing into a less privileged mount
 * namespace. There, host root is intentionally unmapped and stat reports the
 * overflow ID. This is a check of that admitted view, not a substitute for the
 * launcher's physical ownership/image attestation. Never admit an overflow
 * owner in an ordinary local process or on a writable mount. */
export function isCloudDeploymentOwner(candidate, uid) {
  if (uid === 0) return true;
  if (uid !== OVERFLOW_ID || !hasCloudEngineUserNamespace()) return false;
  try {
    return isReadOnlyCloudMount(
      candidate,
      readProc("/proc/self/mountinfo", 2 * 1024 * 1024),
    );
  } catch {
    return false;
  }
}
