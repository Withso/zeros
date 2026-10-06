import { readFileSync } from "node:fs";
import { ResidentPtyHost } from "./resident-host";
import { runResidentControl } from "./resident-control";

// This entry is selected only by the v4 native namespace helper. It cannot
// turn a local desktop, ambient environment or arbitrary CLI into a PTY broker.
async function main(): Promise<void> {
  if (process.platform !== "linux" || process.argv.length !== 2 || process.getuid?.() !== 0 ||
    process.getgid?.() !== 0 || process.getgroups?.().length !== 0)
    throw new Error("Resident namespace required");
  process.umask(0o077);
  const stop = () => process.stdin.destroy();
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  try {
    await runResidentControl(process.stdin, process.stdout, identity => {
      const membership = readFileSync("/proc/self/cgroup", "utf8").trim();
      if (!membership.startsWith("0::/") || membership.includes("\n") ||
        !membership.endsWith(`/engine-workload-${identity.hostId}`))
        throw new Error("Resident scope required");
      return new ResidentPtyHost({ ...identity, root: "/srv/zeros/workspace",
        socketPath: `/run/zeros/resident-${identity.hostId}.sock`, shell: "/bin/bash", identity: { uid: 10001, gid: 10001 } });
    });
  } finally { process.off("SIGTERM", stop); process.off("SIGINT", stop); }
}

main().catch(() => {
  process.stderr.write("Resident workload host stopped\n");
  process.exitCode = 125;
});
