import { closeSync, constants, fstatSync, openSync, readFileSync, readdirSync, realpathSync } from "node:fs";

export const CLOUD_RUNNER_BASE = "/usr/lib/zeros-runner";
const refused = () => new Error("cloud_runner_base_unavailable");
/** An absent marker is the old-base path. A present marker is an exact-base
 * contract, checked on opened descriptors before any manager can be created. */
export function cloudRunnerBaseSupported(fs = { closeSync, fstatSync, openSync, readFileSync, readdirSync, realpathSync }) {
  const read = (name, maximum) => {
    const file = `${CLOUD_RUNNER_BASE}/${name}`;
    const fd = fs.openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || ![0, 65534].includes(stat.uid) || (stat.mode & 0o7777) !== 0o444 ||
        stat.nlink !== 1 || stat.size < 1 || stat.size > maximum || fs.realpathSync(file) !== file) throw refused();
      const bytes = fs.readFileSync(fd, "utf8");
      if (Buffer.byteLength(bytes) !== stat.size) throw refused();
      return bytes;
    } finally { fs.closeSync(fd); }
  };
  let text;
  try { text = read("support.json", 1024); }
  catch (error) { if (error.code === "ENOENT") return false; throw refused(); }
  const value = JSON.parse(text);
  if (Object.keys(value).sort().join(",") !== "schema,systemdMinimum" ||
    value.schema !== "zeros.cloud-runner-base/v1" || value.systemdMinimum !== 254) throw refused();
  read("zeros-runner.target", 4096);
  for (const name of ["", "/empty", "/booted"]) {
    const directory = `${CLOUD_RUNNER_BASE}${name}`;
    const fd = fs.openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isDirectory() || ![0, 65534].includes(stat.uid) || (stat.mode & 0o7777) !== 0o555 ||
        fs.realpathSync(directory) !== directory) throw refused();
      if (name && fs.readdirSync(`/proc/self/fd/${fd}`).length) throw refused();
    } finally { fs.closeSync(fd); }
  }
  return true;
}

/** Every field is established by the installed role probe. The outer root
 * launcher still owns the independent final whole-VM retirement evidence. */
export function cloudRunnerQualificationPassed(value) {
  const fields = ["managerIdentity", "privateMaterial", "stdio", "originalRetirement", "descendantsRetired", "census", "revocation", "managerRetired"];
  return !!value && typeof value === "object" && !Array.isArray(value) && value.version === 1 &&
    Object.keys(value).sort().join(",") === [...fields, "version"].sort().join(",") && fields.every(field => value[field] === true);
}
