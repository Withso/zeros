import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe.skipIf(process.platform !== "linux")("native namespace kernel control admission", () => {
  let directory: string; let binary: string;
  beforeAll(() => {
    directory = mkdtempSync(path.join(tmpdir(), "zeros-native-control-")); binary = path.join(directory, "probe");
    const source = path.join(directory, "probe.c");
    writeFileSync(source, `#define main zeros_namespace_main
#define lstat probe_lstat
#define statfs probe_statfs
#include ${JSON.stringify(path.resolve("scripts/cloud-workspace-validation/sandbox/cloud-engine-namespace.c"))}
#undef main
static unsigned int probe_uid, probe_mode; static unsigned long probe_type;
int probe_lstat(const char *name, struct stat *value) { (void)name; memset(value,0,sizeof(*value)); value->st_uid=probe_uid; value->st_mode=probe_mode; value->st_nlink=1; return 0; }
int probe_statfs(const char *name, struct probe_statfs *value) { (void)name; memset(value,0,sizeof(*value)); value->f_type=probe_type; return 0; }
int main(int argc,char **argv) { if(argc!=4)return 2; probe_uid=strtoul(argv[1],NULL,10); probe_mode=strtoul(argv[2],NULL,8); probe_type=strtoul(argv[3],NULL,16); require_kernel_control("/proc/sysrq-trigger"); return 0; }
`);
    execFileSync("cc", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", source, "-o", binary], { timeout: 15000, stdio: "pipe" });
  });
  afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });
  it.each([[0, "100200", "9fa0"], [65534, "100200", "9fa0"], [65534, "100200", "65735546"]])(
    "accepts fixed kernel control owner %s only on admitted virtual filesystems", (uid, mode, type) => {
      expect(spawnSync(binary, [String(uid), String(mode), String(type)], { timeout: 3000 }).status).toBe(0);
    },
  );
  it.each([[10001, "100200", "9fa0"], [10003, "100200", "65735546"], [65534, "100222", "9fa0"], [65534, "120777", "9fa0"], [65534, "100200", "794c7630"]])(
    "denies writable, mapped-workload, symbolic, or ordinary control files (%s/%s/%s)", (uid, mode, type) => {
      expect(spawnSync(binary, [String(uid), String(mode), String(type)], { timeout: 3000 }).status).toBe(125);
    },
  );
});
