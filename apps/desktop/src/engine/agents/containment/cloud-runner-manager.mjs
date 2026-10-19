import { lstatSync, mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nativeCloudWorkloadIO } from "./cloud-workload-cgroup.mjs";
import { cloudRunnerBaseSupported } from "./cloud-runner-base.mjs";
export { cloudRunnerBaseSupported } from "./cloud-runner-base.mjs";

const ROOT = "/sys/fs/cgroup/system.slice/zeros-host.service/engine-runtime/engine-workload-shared/workload";
const SUPPORT = "/usr/lib/zeros-runner";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const refused = () => new Error("cloud_runner_manager_unavailable");
export const cloudRunnerManagerEnvironment = directory => Object.freeze({
  PATH: "/usr/bin:/bin", LANG: "C.UTF-8", HOME: "/nonexistent", USER: "zeros-engine", LOGNAME: "zeros-engine",
  XDG_RUNTIME_DIR: directory, XDG_CONFIG_HOME: "/nonexistent", XDG_DATA_HOME: "/nonexistent",
  SYSTEMD_UNIT_PATH: SUPPORT, SYSTEMD_GENERATOR_PATH: `${SUPPORT}/empty`,
  SYSTEMD_ENVIRONMENT_GENERATOR_PATH: `${SUPPORT}/empty`, SYSTEMD_LOG_LEVEL: "err", SYSTEMD_LOG_TARGET: "null",
});

/** Host has already put this fixed launcher beneath the shared workload root.
 * The manager creates its init.scope and service groups beneath this root;
 * aggregate limits remain with the unchanged root-owned ancestor. */
export async function runCloudRunnerManager(args) {
  if (args.length !== 4 || !/^\/tmp\/zeros-runners-[A-Za-z0-9]{6}$/.test(args[0]) || !UUID.test(args[1]) ||
    !args.slice(2).every(value => /^[1-9][0-9]{0,19}$/.test(value)) || !cloudRunnerBaseSupported()) throw refused();
  const [directory, boot, dev, ino] = args;
  const identity = nativeCloudWorkloadIO.identity(), self = nativeCloudWorkloadIO.process(identity.pid);
  const root = nativeCloudWorkloadIO.directory(ROOT), privateDirectory = lstatSync(directory);
  if ([identity.uid, identity.gid, identity.euid, identity.egid].some(value => value !== 10003) ||
    self?.directory !== ROOT || root.dev !== dev || root.ino !== ino ||
    !privateDirectory.isDirectory() || privateDirectory.isSymbolicLink() || privateDirectory.uid !== 10003 ||
    (privateDirectory.mode & 0o7777) !== 0o700 || realpathSync(directory) !== directory) throw refused();
  const group = `${ROOT}/runner-${boot}`;
  mkdirSync(group, { mode: 0o700 }); // no adoption/restart of an existing manager
  writeFileSync(`${group}/cgroup.procs`, "0");
  const witness = nativeCloudWorkloadIO.directory(group);
  if (nativeCloudWorkloadIO.process(identity.pid)?.directory !== group || witness.dev !== dev || witness.ino === ino) throw refused();
  if (typeof process.execve !== "function") throw refused();
  const executable = statSync("/usr/lib/systemd/systemd", { bigint: true });
  const hint = `${JSON.stringify({ version: 1, launcher: { pid: identity.pid, startToken: self.startToken },
    manager: { pid: identity.pid, startToken: self.startToken },
    group: { directory: group, dev: witness.dev, ino: witness.ino },
    executable: { dev: String(executable.dev), ino: String(executable.ino) } })}\n`;
  await new Promise((resolve, reject) => process.stdout.write(hint, error => error ? reject(refused()) : resolve()));
  // Preserve the original Host-owned birth. No launcher stays in the cgroup
  // root, so systemd can move itself into init.scope and enable controllers.
  process.execve("/usr/lib/systemd/systemd", ["/usr/lib/systemd/systemd", "--user", "--unit=zeros-runner.target"],
    cloudRunnerManagerEnvironment(directory));
  throw refused();
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCloudRunnerManager(process.argv.slice(2)).then(code => { process.exitCode = code; }, () => { process.exitCode = 70; });
}
