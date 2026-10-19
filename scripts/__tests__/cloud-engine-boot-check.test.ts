import { expect, it, vi } from "vitest";
import { bootFixture, common, control, workload } from "./cloud-boot-admission-fixture";

const protectedPaths = ["/", "/usr", "/opt", "/etc", "/etc/zeros"];
function fixture() {
  const f = bootFixture();
  const uid = { pid: 1122, uid: 10003, euid: 10003, gid: 10003, egid: 10003 };
  const status = ["CapEff", "CapPrm", "CapInh", "CapBnd", "CapAmb"].map(key => `${key}:\t0000000000000000`).join("\n") + "\nNoNewPrivs:\t1\nSeccomp:\t2\n";
  const mounted = [...protectedPaths, f.installation.root, "/srv/zeros/workspace", "/srv/zeros/state", "/srv/zeros/home/agent",
    "/srv/zeros/home/capture", "/srv/zeros/.zeros-setup", "/srv/zeros/.zeros-engine-setup"];
  const files: Record<string, string> = { "/proc/self/status": status, "/proc/self/uid_map": "10003 10003 1\n", "/proc/self/gid_map": "10003 10003 1\n",
    "/proc/self/attr/current": "zeros-cloud-engine (unconfined)\n", "/proc/self/mountinfo": mounted.map((file, i) =>
      `${i + 1} 0 8:1 / ${file} ${protectedPaths.includes(file) || file === f.installation.root || file.includes(".zeros-") ? "ro" : "rw"} - ext4 /dev/vda rw`).join("\n") };
  const metadata = new Map<string, { uid: number; gid: number; mode: number }>();
  for (const file of [...mounted, f.installation.workerRoot]) metadata.set(file, {
    uid: file.startsWith("/srv/zeros/") && !file.includes(".zeros-") ? 10003 : 65534,
    gid: file.startsWith("/srv/zeros/") && !file.includes(".zeros-") ? 10003 : 65534,
    mode: file.includes(".zeros-") ? 0 : 0o755,
  });
  const census = { complete: true, populated: true, workloadPids: [], infrastructurePids: [1122], processes: [{ pid: 1122, startToken: "6789" }],
    common: f.probe.custody.common, groups: 4, censusSha256: "1".repeat(64) };
  const custody = { common: f.probe.custody.common, workload: f.probe.custody.workload,
    infrastructure: [{ kind: "engine", pid: 1122, startToken: "6789", controlDirectory: control, controlIdentity: f.probe.custody.controller.scope }] };
  const ports = { identity: () => uid, read: (file: string) => files[file],
    metadata: (file: string) => {
      const data = metadata.get(file); if (!data) throw Object.assign(new Error("absent"), { code: "ENOENT" });
      return { ...data, isDirectory: () => true, isSymbolicLink: () => false };
    }, realpath: (file: string) => file, filesystem: vi.fn(() => 0xef53),
    rootCredentialDenied: () => true, resources: vi.fn(() => f.probe.resources),
    custody: () => custody, census: () => census };
  return { ...f, ports, files, uid, metadata, census, custody };
}
async function checker() {
  const file = "../cloud-workspace-validation/sandbox/cloud-engine-boot-check.mjs";
  const module = await import(/* @vite-ignore */ file).catch(() => ({}));
  expect(module.checkCloudEngineBoot, "fixed fresh observation helper").toBeTypeOf("function");
  return module.checkCloudEngineBoot;
}

it("observes the exact own real view and original controller, without functional role replay", async () => {
  const f = fixture(), check = await checker();
  const { retirement: _, outputJoined: _joined, ...inner } = f.probe;
  expect(check(f.installation, f.ports)).toEqual(inner);
  expect(f.ports.resources).toHaveBeenCalledOnce();
});
it.each(["uid", "euid", "gid", "egid"])("boot_check_failure_never_publishes: actual %s", async key => {
  const f = fixture(), check = await checker(); f.uid[key] = 0; expect(() => check(f.installation, f.ports)).toThrow();
});
it.each(["uid", "gid"])("refuses non-length-one %s map", async key => {
  const f = fixture(), check = await checker();
  for (const map of ["0 0 4294967295", "0 10003 1", "10003 10003 2", "10003 10003 1\n10004 10004 1", ""]) {
    f.files[`/proc/self/${key}_map`] = map; expect(() => check(f.installation, f.ports)).toThrow();
  }
});
it.each(["CapEff", "CapPrm", "CapInh", "CapBnd", "CapAmb", "NoNewPrivs", "Seccomp"])("refuses independent missing/nonzero %s", async field => {
  const f = fixture(), check = await checker();
  const source = f.files["/proc/self/status"];
  f.files["/proc/self/status"] = source.replace(new RegExp(`${field}:.*`), `${field}: ${field.startsWith("Cap") ? "0000000000000001" : "0"}`);
  expect(() => check(f.installation, f.ports)).toThrow();
  f.files["/proc/self/status"] = source.replace(new RegExp(`${field}:.*\n`), ""); expect(() => check(f.installation, f.ports)).toThrow();
});
it.each(["unconfined", "zeros-cloud-engine (enforce)", "other (unconfined)", ""])("requires actual qualified AppArmor attachment: %s", async profile => {
  const f = fixture(), check = await checker(); f.files["/proc/self/attr/current"] = profile;
  expect(() => check(f.installation, f.ports)).toThrow();
});
it.each(["writable_runtime", "stacked_mount", "nested_foreign", "fuse", "foreign_owner", "root_credential", "private_path", "unmasked_setup"])(
  "refuses current mount/storage/credential policy fault: %s", async fault => {
    const f = fixture(), check = await checker();
    if (fault === "writable_runtime") f.files["/proc/self/mountinfo"] = f.files["/proc/self/mountinfo"].replace(`${f.installation.root} ro`, `${f.installation.root} rw`);
    if (fault === "stacked_mount") f.files["/proc/self/mountinfo"] += `\n100 0 8:1 / ${f.installation.root} ro - ext4 /dev/vdb rw`;
    if (fault === "nested_foreign") f.files["/proc/self/mountinfo"] += `\n100 0 8:2 / /srv/zeros/workspace/foreign rw - ext4 /dev/vdb rw`;
    if (fault === "fuse") f.ports.filesystem.mockReturnValue(0x65735546);
    if (fault === "foreign_owner") f.metadata.get("/srv/zeros/state")!.uid = 0;
    if (fault === "root_credential") f.ports.rootCredentialDenied = () => false;
    if (fault === "private_path") f.metadata.set("/srv/zeros/broker", { uid: 10003, gid: 10003, mode: 0o700 });
    if (fault === "unmasked_setup") f.metadata.get("/srv/zeros/.zeros-setup")!.mode = 0o755;
    expect(() => check(f.installation, f.ports)).toThrow();
  });
it.each(["budget", "unknown_census", "workload", "missing_controller", "wrong_birth", "wrong_scope", "wrong_common", "wrong_workload"])(
  "refuses live resource and full-census fault: %s", async fault => {
    const f = fixture(), check = await checker();
    if (fault === "budget") f.ports.resources.mockImplementation(() => { throw new Error("live Host budget changed"); });
    if (fault === "unknown_census") f.census.complete = false;
    if (fault === "workload") f.census.workloadPids.push(1133);
    if (fault === "missing_controller") f.custody.infrastructure.length = 0;
    if (fault === "wrong_birth") f.census.processes[0].startToken = "9999";
    if (fault === "wrong_scope") f.custody.infrastructure[0].controlDirectory = workload;
    if (fault === "wrong_common") f.census.common = { ...f.census.common, ino: "9999" };
    if (fault === "wrong_workload") f.custody.workload = { ...f.custody.workload, directory: `${common}/foreign` };
    expect(() => check(f.installation, f.ports)).toThrow();
  });
