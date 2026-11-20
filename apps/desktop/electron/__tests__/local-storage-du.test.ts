import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertDuPath, measureWithDu } from "../local-storage/du";

const MiB = 1024 * 1024;
let root: string;

function write(file: string, bytes: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Random content defeats sparse files and compression, so allocation ≈ size.
  fs.writeFileSync(file, Buffer.alloc(bytes, 7).map(() => Math.floor(Math.random() * 256)));
}

/** Runs du without CAP_DAC_OVERRIDE so an unreadable folder is unreadable even
 * when the test host grants every capability (as some sandboxes do). */
function unprivilegedDu(): string | null {
  const probe = path.join(root, "probe");
  fs.mkdirSync(probe);
  fs.chmodSync(probe, 0);
  let readable = true;
  try {
    fs.readdirSync(probe);
  } catch {
    readable = false;
  }
  fs.chmodSync(probe, 0o755);
  fs.rmdirSync(probe);
  if (!readable) return "/usr/bin/du";
  if (spawnSync("setpriv", ["--version"]).status !== 0) return null;
  const wrapper = path.join(root, "du-unprivileged.sh");
  fs.writeFileSync(
    wrapper,
    '#!/bin/sh\nexec setpriv --inh-caps=-all --ambient-caps=-all --bounding-set=-all -- /usr/bin/du "$@"\n',
    { mode: 0o755 },
  );
  return wrapper;
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "zeros-du-")));
});
afterEach(() => {
  for (const dir of [path.join(root, "locked", "inner"), path.join(root, "locked")])
    try {
      fs.chmodSync(dir, 0o755);
    } catch {
      /* not created by this test */
    }
  fs.rmSync(root, { recursive: true, force: true });
});

describe("measureWithDu", () => {
  it("counts allocated bytes without following a symlink and counts a hardlink once", async () => {
    write(path.join(root, "tree", "a.bin"), MiB);
    fs.linkSync(path.join(root, "tree", "a.bin"), path.join(root, "tree", "a-hardlink.bin"));
    write(path.join(root, "outside", "big.bin"), 4 * MiB);
    fs.symlinkSync(path.join(root, "outside"), path.join(root, "tree", "outside-link"));

    const result = await measureWithDu([path.join(root, "tree")], { timeoutMs: 10_000 });

    expect(result.status).toBe("measured");
    expect(result.bytes).toBeGreaterThanOrEqual(MiB);
    expect(result.bytes).toBeLessThan(2 * MiB);
  });

  it("counts a hardlink once across the paths of one category", async () => {
    write(path.join(root, "one", "a.bin"), MiB);
    fs.mkdirSync(path.join(root, "two"));
    fs.linkSync(path.join(root, "one", "a.bin"), path.join(root, "two", "a.bin"));

    const result = await measureWithDu([path.join(root, "one"), path.join(root, "two")], { timeoutMs: 10_000 });

    expect(result.status).toBe("measured");
    expect(result.bytes).toBeLessThan(2 * MiB);
  });

  it("measures nothing for no paths without starting du", async () => {
    const result = await measureWithDu([], { timeoutMs: 10_000, command: "/nonexistent/du" });
    expect(result).toEqual({ status: "measured", bytes: 0 });
  });

  it("reports a vanished path as a lower bound, not an exact total", async () => {
    write(path.join(root, "present", "a.bin"), MiB);
    const result = await measureWithDu([path.join(root, "present"), path.join(root, "missing")], { timeoutMs: 10_000 });
    expect(result.status).toBe("partial");
    expect(result.bytes).toBeGreaterThanOrEqual(MiB);
  });

  it("reports an unreadable folder as a lower bound", async (context) => {
    const du = unprivilegedDu();
    if (!du) context.skip();
    write(path.join(root, "locked", "a.bin"), MiB);
    write(path.join(root, "locked", "inner", "b.bin"), MiB);
    fs.chmodSync(path.join(root, "locked", "inner"), 0);

    const result = await measureWithDu([path.join(root, "locked")], { timeoutMs: 10_000, command: du! });

    expect(result.status).toBe("partial");
    expect(result.bytes).toBeGreaterThanOrEqual(MiB);
    expect(result.bytes).toBeLessThan(2 * MiB);
  });

  it("parses a path that contains a newline", async () => {
    write(path.join(root, "new\nline", "a.bin"), MiB);
    write(path.join(root, "plain", "b.bin"), MiB);
    const result = await measureWithDu([path.join(root, "new\nline"), path.join(root, "plain")], { timeoutMs: 10_000 });
    expect(result.status).toBe("measured");
    expect(result.bytes).toBeGreaterThanOrEqual(2 * MiB);
  });

  it("streams a lower bound as each path completes", async () => {
    write(path.join(root, "a", "a.bin"), MiB);
    write(path.join(root, "b", "b.bin"), MiB);
    const progress: number[] = [];
    const result = await measureWithDu([path.join(root, "a"), path.join(root, "b")], {
      timeoutMs: 10_000,
      onProgress: (bytes) => progress.push(bytes),
    });
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.every((bytes, i) => i === 0 || bytes >= progress[i - 1]!)).toBe(true);
    expect(progress.at(-1)).toBeLessThanOrEqual(result.bytes!);
  });

  it("kills du at the timeout and reports no number when nothing completed", async () => {
    const slow = path.join(root, "slow-du.sh");
    fs.writeFileSync(slow, "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
    const started = Date.now();
    const result = await measureWithDu([root], { timeoutMs: 200, command: slow });
    expect(result).toEqual({ status: "unmeasured", bytes: null, reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("keeps the completed paths as a lower bound when a later path times out", async () => {
    write(path.join(root, "a", "a.bin"), MiB);
    const partial = path.join(root, "partial-du.sh");
    fs.writeFileSync(partial, `#!/bin/sh\nprintf '1024\\t%s\\n' "$6"\nexec sleep 30\n`, { mode: 0o755 });
    const result = await measureWithDu([path.join(root, "a"), path.join(root, "b")], { timeoutMs: 300, command: partial });
    expect(result).toEqual({ status: "partial", bytes: 1024 * 1024, reason: "timeout" });
  });

  it("kills du when cancelled", async () => {
    const slow = path.join(root, "slow-du.sh");
    const pidFile = path.join(root, "pid");
    fs.writeFileSync(slow, `#!/bin/sh\necho $$ > '${pidFile}'\nexec sleep 30\n`, { mode: 0o755 });
    const controller = new AbortController();
    const pending = measureWithDu([root], { timeoutMs: 30_000, command: slow, signal: controller.signal });
    await expect.poll(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim().length > 0).toBe(true);
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    controller.abort();
    expect(await pending).toEqual({ status: "unmeasured", bytes: null, reason: "cancelled" });
    await expect.poll(() => {
      try {
        process.kill(pid, 0);
        return "alive";
      } catch {
        return "gone";
      }
    }).toBe("gone");
  });

  it("does not start when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await measureWithDu([root], { timeoutMs: 1_000, signal: controller.signal, command: "/nonexistent/du" });
    expect(result).toEqual({ status: "unmeasured", bytes: null, reason: "cancelled" });
  });

  it("reports a missing du binary as unmeasured", async () => {
    const result = await measureWithDu([root], { timeoutMs: 1_000, command: path.join(root, "no-du") });
    expect(result).toEqual({ status: "unmeasured", bytes: null, reason: "failed" });
  });

  it("passes paths as arguments after --, never through a shell", async () => {
    const echo = path.join(root, "args.sh");
    const out = path.join(root, "args.txt");
    fs.writeFileSync(echo, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > '${out}'\n`, { mode: 0o755 });
    const tricky = path.join(root, "$(touch pwned); `id` & -rf");
    fs.mkdirSync(tricky);
    await measureWithDu([tricky], { timeoutMs: 5_000, command: echo });
    expect(fs.readFileSync(out, "utf8").split("\n").filter(Boolean)).toEqual(["-s", "-k", "-x", "-P", "--", tricky]);
    expect(fs.existsSync(path.join(root, "pwned"))).toBe(false);
  });
});

describe("assertDuPath", () => {
  it.each([
    ["relative", "relative/path"],
    ["option-like", "-rf"],
    ["traversal", "/Users/me/../../etc"],
    ["trailing slash", "/Users/me/"],
    ["NUL", "/Users/me\0/x"],
    ["filesystem root", "/"],
    ["empty", ""],
    ["non-string", 42],
  ])("refuses a %s path", (_label, value) => {
    expect(() => assertDuPath(value)).toThrow();
  });

  it("accepts a normalized absolute path", () => {
    expect(() => assertDuPath("/Users/me/Library/Application Support/com.zeros")).not.toThrow();
  });
});
