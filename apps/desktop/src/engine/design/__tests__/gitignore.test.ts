import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { designGitignoreSource } from "../gitignore";

const configuration = vi.hoisted(() => vi.fn(() => null as { uid: number; gid: number } | null));
const probe = vi.hoisted(() => ({ inspect: undefined as ((cwd: string) => void) | undefined }));
vi.mock("../../agents/containment/cloud-worker-config", () => ({ loadCloudWorkerConfiguration: configuration }));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, execFileSync: (command: string, args: string[], options: import("node:child_process").ExecFileSyncOptions) => {
    if (args.includes("check-ignore")) probe.inspect?.(String(options.cwd));
    return actual.execFileSync(command, args, options);
  } };
});

describe("managed Design ignore rules", () => {
  it("preserves mixed line endings outside its own block on repeated saves", () => {
    const original = "# Existing rules\r\nbuild/\n.zeros/\r\n";
    const first = designGitignoreSource(original);
    expect(first.startsWith(original)).toBe(true);
    expect(designGitignoreSource(first)).toBe(first);
    const later = "# Later user rules\ncache/\r\n";
    const repaired = designGitignoreSource(first + later);
    expect(repaired.startsWith(original + later)).toBe(true);
    expect(designGitignoreSource(repaired)).toBe(repaired);
  });

  for (const cloud of [false, true]) {
    it.skipIf(cloud && (process.platform !== "linux" || process.getuid?.() !== 0))(
      `checks prospective and nested ignore rules privately for ${cloud ? "a different cloud Git UID" : "unchanged Local Git"}`,
      async () => {
        vi.resetModules();
        const identity = cloud ? { uid: 10001, gid: 10001 } : undefined;
        configuration.mockReturnValue(identity ?? null);
        const { assertDesignFilesNotIgnored } = await import("../gitignore");
        const root = fs.mkdtempSync(path.join(tmpdir(), "zeros-v2-test-ignore-"));
        const temporaries: string[] = [];
        probe.inspect = directory => {
          temporaries.push(directory);
          const inspect = (file: string) => {
            const stat = fs.lstatSync(file);
            expect(stat.uid).toBe(identity?.uid ?? process.getuid?.());
            expect(stat.gid).toBe(identity?.gid ?? process.getgid?.());
            expect(stat.mode & 0o077).toBe(0);
            if (stat.isDirectory()) for (const child of fs.readdirSync(file)) inspect(path.join(file, child));
          };
          if (process.platform !== "win32") inspect(directory);
        };
        const previousMask = process.umask(0o077);
        const write = (file: string, contents: string) => {
          const target = path.join(root, file);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, contents);
          if (identity) {
            fs.chownSync(target, identity.uid, identity.gid);
            for (let dir = path.dirname(target); dir !== path.dirname(root); dir = path.dirname(dir))
              fs.chownSync(dir, identity.uid, identity.gid);
          }
        };
        try {
          if (identity) fs.chownSync(root, identity.uid, identity.gid);
          execFileSync("git", ["init", "-q"], { cwd: root, ...identity, stdio: "pipe" });
          write(".gitignore", "*.toml\n*.json\n");
          const before = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
          const planned = designGitignoreSource(before, ["Brand"]);
          const files = ["Brand/meta/design.toml", "Brand/meta/canvas.json"];
          expect(() => assertDesignFilesNotIgnored(root, files, planned)).not.toThrow();
          write("Brand/meta/.gitignore", "canvas.json\n");
          expect(() => assertDesignFilesNotIgnored(root, files, planned)).toThrow(/still ignored.*Brand\/meta\/canvas.json/);
          expect(fs.readFileSync(path.join(root, ".gitignore"), "utf8")).toBe(before);
          expect(fs.existsSync(path.join(root, ".git/index"))).toBe(false);
          expect(temporaries).toHaveLength(2);
          expect(temporaries.every(directory => !fs.existsSync(directory))).toBe(true);
        } finally {
          probe.inspect = undefined;
          process.umask(previousMask);
          fs.rmSync(root, { recursive: true, force: true });
          configuration.mockReturnValue(null);
          vi.resetModules();
        }
      },
    );
  }
});
