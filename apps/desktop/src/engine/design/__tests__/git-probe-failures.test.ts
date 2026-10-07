import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExecFileOptions, ExecFileSyncOptions } from "node:child_process";

const state = vi.hoisted(() => ({
  cloud: false,
  command: "",
  stderr: "",
  status: 128,
  code: undefined as string | undefined,
  calls: [] as Array<{
    args: string[];
    options: ExecFileOptions | ExecFileSyncOptions;
  }>,
}));
vi.mock("../../agents/containment/cloud-worker-config", () => ({
  loadCloudWorkerConfiguration: () =>
    state.cloud ? { version: 4, uid: 10001, gid: 10001 } : null,
}));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  const failure = () =>
    Object.assign(
      new Error(
        `Command failed: git --work-tree=/private/checkout\n${state.stderr}`,
      ),
      {
        status: state.status,
        code: state.code ?? state.status,
        stderr: state.stderr,
        stdout: "private output",
      },
    );
  return {
    ...actual,
    execFileSync: (
      command: string,
      args: string[],
      options: ExecFileSyncOptions,
    ) => {
      state.calls.push({ args, options });
      if (args.includes(state.command)) throw failure();
      return actual.execFileSync(command, args, options);
    },
    execFile: (
      command: string,
      args: string[],
      options: ExecFileOptions,
      callback: (error: unknown) => void,
    ) => {
      state.calls.push({ args, options });
      if (args.includes(state.command)) {
        callback(failure());
        return { stdin: null };
      }
      return actual.execFile(command, args, options, callback);
    },
  };
});

const temporary: string[] = [];
afterEach(() => {
  for (const root of temporary.splice(0))
    rmSync(root, { recursive: true, force: true });
  state.calls = [];
  state.code = undefined;
  vi.resetModules();
});

describe.each([false, true])(
  "Design Git probe failures (cloud=%s)",
  (cloud) => {
    it("rejects an empty checkout before starting a child process", async () => {
      vi.resetModules();
      Object.assign(state, {
        cloud,
        command: "rev-parse",
        stderr: "",
        status: 128,
        calls: [],
      });
      const { runGitProbeSync } = await import("../../git/git-exec");
      let cause: unknown;
      try {
        runGitProbeSync("", "rev_parse", ["rev-parse", "--absolute-git-dir"]);
      } catch (error) {
        cause = error;
      }
      expect(cause).toMatchObject({ code: "VALIDATION_FAILED" });
      expect(state.calls).toHaveLength(0);
    });

    it.each([
      [
        "rev-parse",
        "rev_parse",
        "fatal: unsafe repository ('/private/checkout' is owned by someone else)",
        "dubious_ownership",
      ],
      [
        "check-ignore",
        "check_ignore",
        "fatal: cannot open '/private/checkout/.git/config': Permission denied",
        "permission_denied",
      ],
      [
        "config",
        "policy_config",
        "fatal: bad config line 1 in file /private/checkout/.git/config",
        "invalid_configuration",
      ],
    ])(
      "closes %s failures while preserving the managed identity",
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
          path.join(tmpdir(), "zeros-design-git-failure-"),
        );
        temporary.push(root);
        mkdirSync(path.join(root, ".git"));
        let cause: unknown;
        try {
          if (command === "config") {
            const { runGit } = await import("../../git/git-exec");
            await runGit(
              root,
              ["diff", "--name-only", "--diff-filter=U", "-z"],
              { readOnly: true },
            );
          } else {
            const { assertDesignFilesNotIgnored } =
              await import("../gitignore");
            assertDesignFilesNotIgnored(
              root,
              ["Brand/meta/design.toml"],
              command === "rev-parse" ? "planned\n" : undefined,
            );
          }
        } catch (error) {
          cause = error;
        }
        expect(cause).toMatchObject({
          name: "GitError",
          code: "GIT_COMMAND_FAILED",
          message: `Managed Git ${operation} failed (${reason}).`,
          context: { operation, reason, exitCode: 128 },
        });
        if (reason === "permission_denied")
          expect(cause).toHaveProperty(
            "remediation",
            "Workspace file permissions need repair.",
          );
        // Serialized diagnostics and Error inspection must not retain raw argv,
        // stderr, stdout, or a nested child-process error with private paths.
        const serialized = JSON.stringify(cause);
        expect(serialized).not.toContain("/private/");
        expect(serialized).not.toContain(root);
        expect(serialized).not.toContain("private output");
        expect(cause).not.toHaveProperty("cause", expect.anything());
        const options = state.calls.at(-1)!.options;
        expect(options.uid).toBe(cloud ? 10001 : undefined);
        expect(options.gid).toBe(cloud ? 10001 : undefined);
      },
    );

    it("retains check-ignore's successful no-match exit 1", async () => {
      vi.resetModules();
      Object.assign(state, {
        cloud,
        command: "check-ignore",
        stderr: "",
        status: 1,
      });
      const root = mkdtempSync(
        path.join(tmpdir(), "zeros-design-git-no-match-"),
      );
      temporary.push(root);
      mkdirSync(path.join(root, ".git"));
      const { assertDesignFilesNotIgnored } = await import("../gitignore");
      expect(() =>
        assertDesignFilesNotIgnored(root, ["Brand/meta/design.toml"]),
      ).not.toThrow();
    });
  },
);
