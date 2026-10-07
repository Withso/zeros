import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { DesignWorkspaceSnapshotWire } from "../../../renderer/platform/bridge/design-bridge";
import type { DesignFrameDocument } from "../../design/document-model";

const privileged = process.geteuid?.() === 0;
let canSwitchUid = false;
if (process.platform === "linux") {
  try {
    const args = [
      "--reuid=10001",
      "--regid=10001",
      "--clear-groups",
      "/usr/bin/id",
      "-u",
    ];
    canSwitchUid =
      execFileSync(
        privileged ? "/usr/bin/setpriv" : "sudo",
        privileged ? args : ["-n", "/usr/bin/setpriv", ...args],
        {
          encoding: "utf8",
          timeout: 5_000,
          stdio: ["ignore", "pipe", "ignore"],
          env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
        },
      ).trim() === "10001";
  } catch {
    /* skip below names the required UID switching capability */
  }
}

vi.mock("../../agents/containment/cloud-worker-config", async (original) => {
  const actual =
    await original<
      typeof import("../../agents/containment/cloud-worker-config")
    >();
  return {
    ...actual,
    loadCloudWorkerConfiguration: () =>
      privileged
        ? {
            version: 4,
            backend: "cloud-worker",
            profile: "zeros-cloud-worker-v4",
            uid: 10001,
            gid: 10001,
          }
        : null,
  };
});

describe.skipIf(!canSwitchUid)(
  "Design Linux UID acceptance (requires root/setpriv; skipped when UID switching is unavailable)",
  () => {
    it("initializes visible Design source, creates/reads an exact frame and diffs content across engine/Git UIDs", async () => {
      if (!privileged) {
        const output = execFileSync(
          "sudo",
          [
            "-n",
            process.execPath,
            path.resolve("node_modules/vitest/vitest.mjs"),
            "run",
            "--config",
            "vitest.config.ts",
            path.relative(process.cwd(), __filename),
            "--maxWorkers=1",
          ],
          {
            cwd: process.cwd(),
            encoding: "utf8",
            timeout: 60_000,
            maxBuffer: 512_000,
            env: {
              PATH: process.env.PATH ?? "/usr/bin:/bin",
              HOME: tmpdir(),
              LANG: "C.UTF-8",
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        expect(output).toContain("1 passed");
        return;
      }

      const ownership = await import("../../files/cloud-workspace-ownership");
      const { WorkspaceService } = await import("../service");
      const { ensureCloudPrimaryWorkspace } =
        await import("../../git/cloud-primary-workspace");
      const { closeState, setStateRootForTesting } =
        await import("../../git/state");
      const { resetWorkspaceDesignApisForTests } =
        await import("../../design/design-api");
      const { forgetDesignDirectoryName } =
        await import("../../design/directory-registry");
      const { parseCloudWorkerConfiguration } =
        await import("../../agents/containment/cloud-worker-config");
      const temporary = fs.mkdtempSync(
        path.join(tmpdir(), "zeros-design-uid-"),
      );
      fs.chownSync(temporary, 10001, 10001);
      const root = path.join(temporary, "workspace");
      fs.mkdirSync(root, { mode: 0o700 });
      fs.chownSync(root, 10001, 10001);
      const home = path.join(temporary, "engine-home");
      fs.mkdirSync(home, { mode: 0o700 });
      const publisher = new ownership.CloudWorkspaceOwnership(root, {
        uid: 10001,
        gid: 10001,
      });
      const marker = JSON.parse(
        fs.readFileSync(
          path.join(
            __dirname,
            "../../../../../../scripts/cloud-workspace-validation/sandbox/cloud-worker.json",
          ),
          "utf8",
        ),
      );
      const profile = parseCloudWorkerConfiguration(
        JSON.stringify({
          ...marker,
          version: 4,
          profile: "zeros-cloud-worker-v4",
        }),
      );
      const oldHome = process.env.HOME;
      const oldMask = process.umask(0o077);
      process.env.HOME = home;
      const workerGit = (...args: string[]) =>
        execFileSync(
          "/usr/bin/setpriv",
          [
            "--reuid=10001",
            "--regid=10001",
            "--clear-groups",
            "/usr/bin/git",
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.test",
            "-c",
            "commit.gpgsign=false",
            "-c",
            `core.hooksPath=${temporary}/no-hooks`,
            ...args,
          ],
          {
            cwd: root,
            encoding: "utf8",
            timeout: 10_000,
            stdio: ["ignore", "pipe", "pipe"],
            env: {
              PATH: "/usr/bin:/bin",
              HOME: temporary,
              LANG: "C.UTF-8",
              GIT_OPTIONAL_LOCKS: "0",
            },
          },
        );
      // Only map publication to this disposable checkout. Exercise the actual
      // v4 gate, descriptor checks, parent publication and filesystem ownership.
      const engineWrites: string[] = [];
      vi.spyOn(ownership, "publishCloudWorkspacePath").mockImplementation(
        (target, fd) => {
          if (fd !== undefined && fs.fstatSync(fd).uid === process.geteuid!())
            engineWrites.push(target);
          if (ownership.publishesCloudWorkspaceOwnership(profile))
            publisher.publish(target, fd);
        },
      );
      try {
        workerGit("init", "-q", "-b", "main");
        workerGit(
          "remote",
          "add",
          "origin",
          "https://example.test/fixture/repo.git",
        );
        fs.writeFileSync(path.join(root, "README.md"), "fixture\n", {
          mode: 0o600,
        });
        fs.chownSync(path.join(root, "README.md"), 10001, 10001);
        workerGit("add", "--", "README.md");
        workerGit("commit", "-qm", "Initial fixture");
        const head = workerGit("rev-parse", "HEAD").trim();
        const index = fs.readFileSync(path.join(root, ".git", "index"));
        setStateRootForTesting(path.join(temporary, "state"));
        await ensureCloudPrimaryWorkspace(root, {
          organizationId: randomUUID(),
          workspaceId: randomUUID(),
        });
        const service = new WorkspaceService(root, {
          primaryDesignWorkspace: true,
        });
        const request = (op: string, params: Record<string, unknown> = {}) =>
          service.handle(
            op,
            { workspaceId: "local-main", ...params },
            {
              remote: true,
              cloudWorker: true,
              hostLocalResources: false,
              cloudActorIdentity: {
                userId: "fixture-user",
                deviceId: "fixture-device",
              },
              cloudFileActor: { role: "owner", authorized: () => true },
            },
          );
        // A genuine worker-UID config failure must retain its safe category
        // before any Design write. This also proves managed Git drops engine UID.
        const config = path.join(root, ".git", "config");
        fs.chownSync(config, 0, 0);
        fs.chmodSync(config, 0o600);
        try {
          await expect(request("design.initialize")).rejects.toMatchObject({
            code: "GIT_COMMAND_FAILED",
            message: "Managed Git policy_config failed (permission_denied).",
          });
        } finally {
          fs.chownSync(config, 10001, 10001);
        }
        const { snapshot: initialized } = (await request(
          "design.initialize",
        )) as { snapshot: DesignWorkspaceSnapshotWire };
        expect(initialized.directory).toBeTruthy();
        const directory = initialized.directory!;
        const listing = (await request("file.tree", {
          includeDesignDirectories: true,
        })) as { files: string[]; designDirectories: string[] };
        expect(listing.designDirectories).toContain(directory);
        expect(listing.files).toContain(`${directory}/meta/design.toml`);
        expect(listing.files).toContain(`${directory}/rules.md`);
        const created = (await request("design.frame.create", {
          title: "UID acceptance",
        })) as {
          frame: { file: string };
          snapshot: DesignWorkspaceSnapshotWire;
        };
        const { frame } = (await request("design.frame", {
          frame: created.frame.file,
        })) as { frame: DesignFrameDocument };
        expect(frame.file).toBe(created.frame.file);
        expect(
          created.snapshot.frames.find((value) => value.file === frame.file)
            ?.sourceVersion,
        ).toBe(frame.sourceVersion);
        expect(frame.sourceVersion).toMatch(/^[a-f0-9]{24}$/);
        expect(frame.srcDoc).toContain("UID acceptance");
        const source = `${directory}/${frame.file}`;
        const frameListing = (await request("file.tree", {
          includeDesignDirectories: true,
        })) as { files: string[] };
        expect(frameListing.files).toContain(source);
        for (const target of [
          directory,
          `${directory}/meta/design.toml`,
          `${directory}/meta/canvas.json`,
          `${directory}/rules.md`,
          source,
          ".gitignore",
        ]) {
          const info = fs.statSync(path.join(root, target));
          expect(info.uid).toBe(10001);
          expect(info.gid).toBe(10001);
          expect(info.mode & 0o077).toBe(0);
        }
        expect(engineWrites.length).toBeGreaterThan(0);
        // Creation is ordinary uncommitted source. Check it did not stage or
        // commit, then explicitly stage this new file to ask Git for its patch.
        expect(workerGit("rev-parse", "HEAD").trim()).toBe(head);
        expect(fs.readFileSync(path.join(root, ".git", "index"))).toEqual(
          index,
        );
        workerGit("add", "--", source, ".gitignore");
        const patch = await request("git.diff", {
          filePath: source,
          mode: "index-vs-head",
        });
        expect(JSON.stringify(patch)).toContain("UID acceptance");
        expect(workerGit("diff", "--stat", "HEAD")).toContain(".gitignore");
        expect(workerGit("rev-parse", "HEAD").trim()).toBe(head);
        expect(process.geteuid!()).toBe(0);
      } finally {
        vi.restoreAllMocks();
        resetWorkspaceDesignApisForTests();
        forgetDesignDirectoryName(root);
        closeState();
        setStateRootForTesting(null);
        if (oldHome === undefined) delete process.env.HOME;
        else process.env.HOME = oldHome;
        process.umask(oldMask);
        fs.rmSync(temporary, { recursive: true, force: true });
      }
    }, 70_000);
  },
);
