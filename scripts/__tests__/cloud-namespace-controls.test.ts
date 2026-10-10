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

describe.skipIf(process.platform !== "linux")("native runtime identity selection",()=>{
  let directory:string,binary:string;
  beforeAll(()=>{
    directory=mkdtempSync(path.join(tmpdir(),"zeros-native-runtime-"));binary=path.join(directory,"probe");
    const source=path.join(directory,"probe.c");
    writeFileSync(source,`#define main zeros_namespace_main
#include ${JSON.stringify(path.resolve("scripts/cloud-workspace-validation/sandbox/cloud-engine-namespace.c"))}
#undef main
int main(int argc,char **argv) { if(argc!=2)return 2; select_runtime(argv[1]); printf("%s\\n%s\\n%s\\n%d\\n",runtime_root,worker_root,runtime_node,runtime_version); return 0; }
`);
    execFileSync("cc",["-std=c11","-O2","-Wall","-Wextra","-Werror",source,"-o",binary],{timeout:15000,stdio:"pipe"});
  });
  afterAll(()=>{if(directory)rmSync(directory,{recursive:true,force:true});});
  it("constructs only physical entrypoints from a validated runtime ID",()=>{
    const id=`r1-${"a".repeat(64)}`,root=`/opt/zeros-infra/${id}`;
    const result=spawnSync(binary,[id],{encoding:"utf8",timeout:3000});
    expect(result.status).toBe(0);expect(result.stdout).toBe(`${root}\n${root}/worker\n${root}/bin/node\n4\n`);
  });
  it.each(["/zeros/current","../../untrusted",`r1-${"A".repeat(64)}`,`r1-${"a".repeat(63)}`,`r1-${"a".repeat(64)}/../other`,"--v3"])("rejects an untrusted runtime argument %s",value=>{
    expect(spawnSync(binary,[value],{timeout:3000}).status).toBe(125);
  });
});

describe.skipIf(process.platform !== "linux")("retired namespace entrypoints", () => {
  let directory: string, binary: string;
  beforeAll(() => {
    directory = mkdtempSync(path.join(tmpdir(), "zeros-retired-namespace-"));
    binary = path.join(directory, "namespace");
    const source = path.join(directory, "probe.c");
    writeFileSync(source, `#define setgroups refuse_legacy_identity_map
#define getuid namespace_uid
#define geteuid namespace_euid
#define getgid namespace_gid
#include ${JSON.stringify(path.resolve("scripts/cloud-workspace-validation/sandbox/cloud-engine-namespace.c"))}
uid_t namespace_uid(void) { return 0; }
uid_t namespace_euid(void) { return 0; }
gid_t namespace_gid(void) { return 0; }
int refuse_legacy_identity_map(size_t count, const gid_t *groups) { (void)count; (void)groups; _exit(99); }
`);
    execFileSync("cc", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", source, "-o", binary], { timeout: 15000, stdio: "pipe" });
  });
  afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });
  it.each([[], ["--v3"], ["--qualify"], ["--v3", "--qualify-agent"]].map(args => ({ args })))("rejects retired args $args before changing identity maps", ({ args }) => {
    expect(spawnSync(binary, args, { timeout: 3000 }).status).toBe(125);
  });
});

describe.skipIf(process.platform !== "linux")("non-root shared engine identity map", () => {
  it("maps only non-root10003 identically in both kernel maps", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "zeros-engine-map-"));
    try {
      const source = path.join(directory, "probe.c"), binary = path.join(directory, "probe");
      writeFileSync(source, `#define main zeros_namespace_main
#define open map_open
#define write map_write
#define close map_close
#include ${JSON.stringify(path.resolve("scripts/cloud-workspace-validation/sandbox/cloud-engine-namespace.c"))}
#undef main
#undef open
#undef write
#undef close
static char captured[128];
int map_open(const char *file, int flags, ...) { (void)flags; if (strcmp(file,"/proc/234/uid_map") && strcmp(file,"/proc/234/gid_map")) return -1; return 42; }
ssize_t map_write(int fd,const void *value,size_t size) { if(fd!=42 || size>=sizeof(captured)) return -1; memcpy(captured,value,size);captured[size]=0;return size; }
int map_close(int fd) { return fd==42?0:-1; }
int main(void) { write_map(234,"uid");fputs(captured,stdout);write_map(234,"gid");fputs(captured,stdout);return 0; }
`);
      execFileSync("cc", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", source, "-o", binary], {timeout:15000,stdio:"pipe"});
      expect(execFileSync(binary, {encoding:"utf8",timeout:3000})).toBe("10003 10003 1\n10003 10003 1\n");
    } finally { rmSync(directory, {recursive:true,force:true}); }
  });
});
