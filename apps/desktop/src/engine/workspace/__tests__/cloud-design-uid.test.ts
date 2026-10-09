import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { DesignWorkspaceSnapshotWire } from "../../../renderer/platform/bridge/design-bridge";
import type { DesignFrameDocument } from "../../design/document-model";

vi.mock("../../agents/containment/cloud-worker-config", async (original) => {
  const actual =
    await original<
      typeof import("../../agents/containment/cloud-worker-config")
    >();
  return {
    ...actual,
    loadCloudWorkerConfiguration: () => ({version: 4, backend: 'cloud-worker', profile: 'zeros-cloud-worker-v4',
      uid: process.geteuid?.(), gid: process.getegid?.()}),
  };
});

describe.runIf(process.platform === "linux")(
  "Design API and Git share the engine identity",
  () => {
    it("initializes visible Design source, creates/reads an exact frame and diffs content as the engine user", async () => {
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
      const temporary = fs.mkdtempSync(
        path.join(tmpdir(), "zeros-design-uid-"),
      );
      const root = path.join(temporary, "workspace");
      fs.mkdirSync(root, { mode: 0o700 });
      const home = path.join(temporary, "engine-home");
      fs.mkdirSync(home, { mode: 0o700 });
      const publisher = new ownership.CloudWorkspaceOwnership(root, {
        uid: process.geteuid!(),
        gid: process.getegid!(),
      });
      const profile = {version: 4 as const, uid: process.geteuid!(), gid: process.getegid!()};
      const oldHome = process.env.HOME;
      const oldMask = process.umask(0o077);
      process.env.HOME = home;
      const engineGit = (...args: string[]) =>
        execFileSync(
          "/usr/bin/git",
          [
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
      // Map publication only to this disposable checkout; descriptors and
      // original engine ownership still flow through the real publisher.
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
        engineGit("init", "-q", "-b", "main");
        engineGit(
          "remote",
          "add",
          "origin",
          "https://example.test/fixture/repo.git",
        );
        fs.writeFileSync(path.join(root, "README.md"), "fixture\n", {
          mode: 0o600,
        });
        engineGit("add", "--", "README.md");
        engineGit("commit", "-qm", "Initial fixture");
        const head = engineGit("rev-parse", "HEAD").trim();
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
          title: "Engine identity acceptance",
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
        expect(frame.srcDoc).toContain("Engine identity acceptance");
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
          expect(info.uid).toBe(process.geteuid!());
          expect(info.gid).toBe(process.getegid!());
          expect(info.mode & 0o077).toBe(0);
        }
        expect(engineWrites.length).toBeGreaterThan(0);
        // Creation is ordinary uncommitted source. Check it did not stage or
        // commit, then explicitly stage this new file to ask Git for its patch.
        expect(engineGit("rev-parse", "HEAD").trim()).toBe(head);
        expect(fs.readFileSync(path.join(root, ".git", "index"))).toEqual(
          index,
        );
        engineGit("add", "--", source, ".gitignore");
        const patch = await request("git.diff", {
          filePath: source,
          mode: "index-vs-head",
        });
        expect(JSON.stringify(patch)).toContain("Engine identity acceptance");
        expect(engineGit("diff", "--stat", "HEAD")).toContain(".gitignore");
        expect(engineGit("rev-parse", "HEAD").trim()).toBe(head);
        expect(process.geteuid!()).toBe(profile.uid);
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
