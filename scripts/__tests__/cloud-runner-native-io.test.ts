import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Compile the actual native code. Only the named systemd stop is intercepted;
// file/descriptor IO is real. This is not a systemd/base qualification claim.
describe.runIf(process.platform === "linux")("original native runner descriptor retirement", () => {
  let root: string, binary: string;
  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "zeros-runner-native-io-"));
    binary = path.join(root, "probe");
    const source = path.resolve("scripts/cloud-workspace-validation/sandbox/cloud-runner-bus.c");
    writeFileSync(path.join(root, "probe.c"), `
      #define _GNU_SOURCE
      #include <systemd/sd-bus.h>
      static int named_stops;
      static int named_stop(sd_bus *b,const char *d,const char *p,const char *i,const char *m,sd_bus_error *e,sd_bus_message **r,const char *t,...) {
        (void)b;(void)d;(void)p;(void)i;(void)m;(void)e;(void)r;(void)t; named_stops++; return 0;
      }
      #define sd_bus_call_method named_stop
      #define main original_main
      #include ${JSON.stringify(source)}
      #undef main
      int main(int argc,char **argv) {
        if(argc!=3)return 90;
        int group=open(argv[2],O_DIRECTORY|O_RDONLY|O_CLOEXEC);
        if(group<0)return 91;
        if(!strcmp(argv[1],"stop")) {
          char old[PATH_MAX];snprintf(old,sizeof(old),"%s-old",argv[2]);
          if(rename(argv[2],old)||mkdir(argv[2],0700))return 92;
          char next[PATH_MAX];snprintf(next,sizeof(next),"%s/cgroup.kill",argv[2]);
          int replaced=open(next,O_CREAT|O_EXCL|O_WRONLY,0600);if(replaced<0)return 93;close(replaced);
          stop_original(group); printf("{\\"namedStops\\":%d}\\n",named_stops);
        } else if(!strcmp(argv[1],"empty")) printf("{\\"empty\\":%s}\\n",empty(group)?"true":"false");
        else return 94;
        close(group);return 0;
      }
    `);
    const result = spawnSync("cc", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", path.join(root, "probe.c"), "-lsystemd", "-o", binary], { encoding: "utf8", timeout: 30_000 });
    expect(result.status, result.stderr).toBe(0);
  });
  afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });
  it("signals only the opened original group after the same path is replaced", () => {
    const directory = path.join(root, "unit"); mkdirSync(directory);
    writeFileSync(path.join(directory, "cgroup.kill"), "");
    const result = spawnSync(binary, ["stop", directory], { encoding: "utf8", timeout: 5000 });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ namedStops: 0 });
    expect(readFileSync(path.join(directory + "-old", "cgroup.kill"), "utf8")).toBe("1");
    expect(readFileSync(path.join(directory, "cgroup.kill"), "utf8")).toBe("");
  });
  it("needs an explicit empty event, and never treats a missing or malformed event as empty", () => {
    const directory = path.join(root, "census"); mkdirSync(directory);
    const probe = () => spawnSync(binary, ["empty", directory], { encoding: "utf8", timeout: 5000 });
    expect(probe().status).toBe(70);
    writeFileSync(path.join(directory, "cgroup.events"), "populated 1\nfrozen 0\n");
    expect(JSON.parse(probe().stdout)).toEqual({ empty: false });
    writeFileSync(path.join(directory, "cgroup.events"), "populated 0x\nfrozen 0\n");
    expect(JSON.parse(probe().stdout)).toEqual({ empty: false });
    writeFileSync(path.join(directory, "cgroup.events"), "populated 0\nfrozen 0\n");
    expect(JSON.parse(probe().stdout)).toEqual({ empty: true });
  });
});
