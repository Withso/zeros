import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExecFileOptions } from "node:child_process";

const state = vi.hoisted(() => ({
  cloud: false,
  command: "",
  stderr: "",
  status: 128,
  calls: [] as Array<{ args: string[]; options: ExecFileOptions }>,
}));
vi.mock("../../agents/containment/cloud-worker-config", () => ({
  loadCloudWorkerConfiguration: () =>
    state.cloud ? { version: 4, uid: 10001, gid: 10001 } : null,
}));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFileSync: (
    _command: string,
    args: string[],
    options: ExecFileOptions,
  ) => {
    state.calls.push({ args, options });
    if (args.includes(state.command))
      throw Object.assign(
        new Error(`Command failed: git ${args.join(" ")}\n${state.stderr}`),
        {
          status: state.status,
          stderr: state.stderr,
        },
      );
    return args.includes("rev-parse") ? ".git/info/exclude\n" : "";
  },
}));
const temporary: string[] = [];
afterEach(() => {
  for (const root of temporary.splice(0))
    rmSync(root, { recursive: true, force: true });
  state.calls = [];
  vi.resetModules();
});

describe.each([false, true])(
  "Design settings Git probes (cloud=%s)",
  (cloud) => {
    it.each([
      [
        "rev-parse",
        "rev_parse",
        "fatal: cannot access '/private/checkout': Permission denied",
        "permission_denied",
      ],
      [
        "ls-files",
        "ls_files",
        "fatal: not a git repository: /private/checkout",
        "not_a_repository",
      ],
      [
        "check-ignore",
        "check_ignore",
        "fatal: this operation must be run in a work tree: /private/checkout",
        "worktree_required",
      ],
    ])(
      "preserves the underlying %s failure without leaking paths",
      async (command, operation, stderr, reason) => {
        vi.resetModules();
        Object.assign(state, {
          cloud,
          command,
          stderr,
          status: 128,
          calls: [],
        });
        const root = mkdtempSync(
          path.join(tmpdir(), "zeros-design-settings-git-"),
        );
        temporary.push(root);
        mkdirSync(path.join(root, ".git", "info"), { recursive: true });
        const { ensureLocalSettingsIgnored } = await import("../personal-repo");
        let cause: unknown;
        try {
          ensureLocalSettingsIgnored(root);
        } catch (error) {
          cause = error;
        }
        expect(cause).toMatchObject({
          code: "GIT_COMMAND_FAILED",
          message: `Managed Git ${operation} failed (${reason}).`,
          context: { operation, reason, exitCode: 128 },
        });
        expect(JSON.stringify(cause)).not.toContain("/private/");
        expect(JSON.stringify(cause)).not.toContain(root);
        const options = state.calls.at(-1)!.options;
        expect(options.uid).toBe(cloud ? process.geteuid?.() : undefined);
        expect(options.gid).toBe(cloud ? process.geteuid?.() : undefined);
      },
    );

    it("handles check-ignore exit 1 as a missing exclusion", async () => {
      vi.resetModules();
      Object.assign(state, {
        cloud,
        command: "check-ignore",
        stderr: "",
        status: 1,
        calls: [],
      });
      const root = mkdtempSync(
        path.join(tmpdir(), "zeros-design-settings-no-match-"),
      );
      temporary.push(root);
      mkdirSync(path.join(root, ".git", "info"), { recursive: true });
      const { ensureLocalSettingsIgnored } = await import("../personal-repo");
      expect(() => ensureLocalSettingsIgnored(root)).toThrow(/^Cannot exclude/);
    });
  },
);
