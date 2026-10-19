import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

it.skipIf(process.platform !== "linux")("unknown boot cleanup retains the root monitor and inherited locks after bounded refusal", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "zeros-boot-custody-"));
  const files = ["setup", "engine"].map(name => path.join(directory, `${name}.lock`));
  const fds = files.map(file => openSync(file, "wx+", 0o600));
  let child: ReturnType<typeof spawn> | undefined, timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    for (const fd of fds) expect(spawnSync("/usr/bin/flock", ["--exclusive", "--nonblock", "3"], {
      stdio: ["ignore", "ignore", "ignore", fd], timeout: 5000,
    }).status).toBe(0);
    const source = `
      const {launchCloudEngine} = await import(process.argv[1]);
      const signals = {on(name, listener) {
        process.on(name, (...args) => {
          listener(...args);
          if(name==='SIGTERM') process.stdout.write('termination-retained\\n');
        });
      }};
      try {
        await launchCloudEngine({operation:'boot-check', bootBudgetMs:1000,
          runtime:{profile:'v4'}, signals, assertOutside(){}, assertBootIdle(){},
          scope:{prepare(){}, custodySeed(){return {}}, placement:'fixture',
            pinBootRetirement(){return {assertCurrent(){}, async retire(){throw new Error('unknown')}}}},
          prepare(){throw new Error('fixture view refused')}
        });
        process.exit(1);
      } catch {
        process.exitCode=125;
        process.stdout.write('custody-retained\\n');
      }
    `;
    child = spawn(process.execPath, ["--input-type=module", "-e", source,
      pathToFileURL(path.resolve("scripts/cloud-workspace-validation/sandbox/cloud-engine-launcher.mjs")).href], {
      env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "ignore", "ignore", ...fds],
    });
    for (const fd of fds.splice(0)) closeSync(fd);
    const [message] = await Promise.race([
      once(child.stdout!, "data"),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("custody fixture timeout")), 5000); }),
    ]);
    clearTimeout(timeout);
    expect(String(message)).toBe("custody-retained\n");
    const contenders = () => files.map(file => spawnSync("/usr/bin/flock", ["--nonblock", "--conflict-exit-code", "73", file, "/usr/bin/true"], { timeout: 5000 }).status);
    expect(contenders()).toEqual([73, 73]);
    const acknowledged = Promise.race([
      once(child.stdout!, "data"),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("custody signal timeout")), 5000); }),
    ]);
    child.kill("SIGTERM");
    expect(String((await acknowledged)[0])).toBe("termination-retained\n"); clearTimeout(timeout);
    expect(child.exitCode).toBeNull(); expect(child.signalCode).toBeNull(); expect(contenders()).toEqual([73, 73]);
    const closed = once(child, "close"); child.kill("SIGKILL"); await closed;
    expect(contenders()).toEqual([0, 0]);
  } finally {
    clearTimeout(timeout);
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close"); child.kill("SIGKILL"); await closed;
    }
    for (const fd of fds) closeSync(fd);
    rmSync(directory, { recursive: true, force: true });
  }
}, 15000);
