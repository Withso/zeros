import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Real files behind a logical VM root; tests never write to /etc or /run. */
export function cloudRuntimeFixture({ mapAbsoluteLinks = true } = {}) {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "zeros-runtime-root-")));
  const hostUid = fs.statSync(directory).uid;
  const physical = (file: string) => path.join(directory, file);
  const logical = (file: string) => file === directory ? "/" :
    file.startsWith(directory + "/") ? file.slice(directory.length) : file;
  const owners = new Map<string, number>();
  const descriptors = new Map<number, string>();
  const metadata = (stat: fs.Stats, file: string) => Object.assign(stat, {
    uid: owners.get(file) ?? (stat.uid === hostUid ? 0 : stat.uid),
  });
  const filesystem = {
    lstatSync: (file: string) => metadata(fs.lstatSync(physical(file)), file),
    realpathSync: (file: string) => logical(fs.realpathSync.native(physical(file))),
    readlinkSync: (file: string) => logical(fs.readlinkSync(physical(file))),
    readdirSync: (file: string) => fs.readdirSync(physical(file)),
    openSync: (file: string, flags: number) => {
      const fd = fs.openSync(physical(file), flags);
      descriptors.set(fd, file);
      return fd;
    },
    fstatSync: (fd: number) => metadata(fs.fstatSync(fd), descriptors.get(fd)!),
    readSync: fs.readSync,
    closeSync: (fd: number) => { descriptors.delete(fd); fs.closeSync(fd); },
  };
  const mkdir = (file: string) => {
    const target = physical(file);
    const firstCreated = fs.mkdirSync(target, { recursive: true, mode: 0o755 });
    if (!firstCreated) return;
    // Mounted runtime directories must remain traversable with a strict umask.
    for (let directory = target; ; directory = path.dirname(directory)) {
      fs.chmodSync(directory, 0o755);
      if (directory === firstCreated) break;
    }
  };
  const write = (file: string, value: unknown, mode = 0o444) => {
    mkdir(path.dirname(file));
    const target = physical(file);
    // Replace admitted read-only files through their user-owned parent rather
    // than relying on root/DAC override to truncate them during test setup.
    fs.rmSync(target, { force: true });
    fs.writeFileSync(target, typeof value === "string" ? value : JSON.stringify(value), { flag: "wx", mode });
    fs.chmodSync(target, mode);
  };
  const link = (file: string, target: string) => {
    mkdir(path.dirname(file));
    // Keep absolute VM links inside the fixture so the kernel is the traversal
    // oracle. Namespace tests retain VM-absolute links for their mounted view.
    fs.symlinkSync(mapAbsoluteLinks && path.isAbsolute(target) ? directory + target : target, physical(file));
  };
  const descriptor = {
    schema: "zeros.active-runtime/v1",
    runtimeId: `r1-${"a".repeat(64)}`,
    manifestSha256: "a".repeat(64),
    root: `/opt/zeros-infra/r1-${"a".repeat(64)}`,
    baseCompatibilityId: `bc1-${"b".repeat(64)}`,
    installerReceiptSha256: "c".repeat(64),
    bootId: "12345678-1234-4234-8234-123456789abc",
    supervisorSessionId: "22345678-1234-4234-8234-123456789abc",
    cgroupRoot: "/sys/fs/cgroup/system.slice/zeros-host.service",
  };
  const marker = { version: 4, backend: "cloud-worker", profile: "zeros-cloud-worker-v4", uid: 10001, gid: 10001 };
  const install = (root = descriptor.root) => {
    for (const file of ["bin/node", "bin/start-engine.sh", "bin/cloud-engine-namespace", "bin/cloud-process-supervisor",
      "worker/dist-engine/cli.js", "worker/package.json", "worker/apps/desktop/src/engine/agents/containment/zsr-supervisor.mjs",
      "lib/zeros/cloud-worker-supervisor.mjs", "lib/zeros/setup-cloud-workspace.mjs", "manifest.json"])
      write(`${root}/${file}`, "installed", 0o555);
  };
  install();
  write("/etc/zeros/cloud-worker.json", marker);
  write("/run/zeros/active-runtime.json", descriptor, 0o600);
  mkdir("/opt/zeros/sessions");
  link("/zeros", "/opt/zeros");
  link("/opt/zeros/current", `../zeros-infra/${descriptor.runtimeId}`);
  for (const name of ["bin", "worker", "manifest.json"]) link(`/opt/zeros/${name}`, `current/${name}`);
  link("/opt/zeros/logs", "/srv/zeros/log");
  link("/opt/zeros/state", "/srv/zeros/state");
  write("/opt/zeros/disk-epoch", "1\n", 0o600);
  return { directory, physical, filesystem, owners, descriptor, marker, mkdir, write, link, install,
    dispose: () => fs.rmSync(directory, { recursive: true, force: true }) };
}
