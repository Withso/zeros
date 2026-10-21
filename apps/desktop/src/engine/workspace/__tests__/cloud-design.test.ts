import type { DesignTransaction } from "@zeros/design-core";
import type { CloudActorRole } from "@zeros/protocol/cloud-actors";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bridgeDesignApplyTransaction,
  bridgeDesignCreateFrame,
  bridgeDesignFrame,
  bridgeDesignFoundationOpen,
  bridgeDesignHistory,
  bridgeDesignInsertAsset,
  bridgeDesignListDirectories,
  bridgeDesignMoveFrames,
  bridgeDesignPreview,
  bridgeDesignSave,
  bridgeDesignSnapshot,
  bridgeDesignStyleBuildPresence,
  bridgeAdoptDesignDirectory,
  bridgePreviewExistingDesignDirectory,
  type DesignWorkspaceSnapshotWire,
} from "../../../renderer/platform/bridge/design-bridge";
import { cloudWorkspaceKey } from "../../../renderer/platform/bridge/cloud-workspace-key";
import {
  WorkspaceRuntimeClient,
  type CloudPeer,
} from "../../../renderer/platform/bridge/workspace-runtime-client";
import { workspaceOp } from "../../../renderer/platform/bridge/workspace-bridge";
import { RuntimeClient } from "../../../renderer/platform/bridge/ws-client";
import { designWorkspaceSnapshotMatchesPath } from "../../../renderer/features/design-workspace/state/design-workspace-boot-cache";
import { cloudActorMaySend } from "../../cloud-actor-policy";
import { resetWorkspaceDesignApisForTests } from "../../design/design-api";
import { forgetDesignDirectoryName } from "../../design/directory-registry";
import { serializeDesignRegistration } from "../../design/manifest";
import { ensureCloudPrimaryWorkspace } from "../../git/cloud-primary-workspace";
import { closeState, setStateRootForTesting } from "../../git/state";
import type { EngineMessage } from "../../types";
import { WorkspaceService } from "../service";
import { captureDesignFrameContext, createDesignFrameContext, inspectDesignFrameContext, openDesignFramePreview } from "../../../renderer/platform/bridge/design-context-bridge";
import { setDesignCaptureConfig } from "../../design/capture-client";
import { startDesignCaptureService } from "../../design/capture-service";
import { runDesignVerificationCli } from "../../design/verification-cli";

/** Real renderer routing, bridge schemas, worker role policy, Design store and
 * Git; only the network/worker attestation are replaced by an in-process peer. */
describe("cloud Design checkout round trips", () => {
  let temporary: string;
  let root: string;
  let key: string;
  let service: WorkspaceService;
  let scope: {
    organizationId: string;
    workspaceId: string;
    root: string;
    engineWorkspaceId: string;
  };
  const clients: WorkspaceRuntimeClient[] = [];
  const userId = "11111111-1111-4111-8111-111111111111";
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

  function client(deviceId: string, role: CloudActorRole = "owner") {
    const request = vi.fn(async (message: EngineMessage) => {
      if (!cloudActorMaySend(role, message, service))
        throw new Error("Cloud actor cannot perform this operation");
      if (message.type !== "WORKSPACE_REQUEST")
        throw new Error("Unexpected request");
      const result =
        message.op === "chats.list"
          ? { chats: [], chatDeletions: [] }
          : await service.handle(message.op, message.params, {
              remote: true,
              cloudWorker: true,
              hostLocalResources: false,
              cloudActorIdentity: { userId, deviceId },
              cloudFileActor: { role, authorized: () => true },
            });
      return { type: "WORKSPACE_RESPONSE", op: message.op, result };
    });
    const bridge = new WorkspaceRuntimeClient({
      open: async () =>
        ({
          client: {
            request,
            status: "connected",
            on: () => () => {},
            onStatusChange: () => () => {},
          },
          scope,
          release: () => {},
        }) as unknown as CloudPeer,
      workspaces: () => [],
    });
    clients.push(bridge);
    return { bridge, request };
  }

  async function initialize(bridge: RuntimeClient) {
    const result = (await workspaceOp(bridge, "design.initialize", {
      workspaceId: key,
    })) as { snapshot: DesignWorkspaceSnapshotWire };
    expect(designWorkspaceSnapshotMatchesPath(result.snapshot, key)).toBe(true);
    const created = await bridgeDesignCreateFrame(bridge, key, "Cloud frame");
    const frame = await bridgeDesignFrame(bridge, key, created.frame.file);
    return { frame, directory: result.snapshot.directory! };
  }

  function move(frame: string, revision: string, x: number): DesignTransaction {
    return {
      schemaVersion: 1,
      transactionId: randomUUID(),
      documentId: `frame:${frame}`,
      baseRevision: revision,
      actor: { kind: "human", id: "untrusted-client" },
      createdAt: Date.now(),
      intent: "Move frame",
      operations: [
        {
          operationId: "move",
          type: "frame.set-geometry",
          frame,
          geometry: { x, y: 0, width: 400, height: 300, z: 0 },
        },
      ],
    };
  }

  beforeEach(async () => {
    vi.spyOn(RuntimeClient.prototype, "request").mockRejectedValue(
      new Error("Unexpected Local engine dispatch"),
    );
    temporary = await mkdtemp(path.join(tmpdir(), "zeros-v2-test-design-"));
    root = path.join(temporary, "repo");
    await mkdir(root);
    setStateRootForTesting(path.join(temporary, "state"));
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.test");
    git("init", "--bare", "-q", path.join(temporary, "remote.git"));
    git("remote", "add", "origin", path.join(temporary, "remote.git"));
    await writeFile(path.join(root, "code.txt"), "base\n");
    git("add", "code.txt");
    git("commit", "-qm", "Base");
    scope = {
      organizationId: randomUUID(),
      workspaceId: randomUUID(),
      root,
      engineWorkspaceId: "local-main",
    };
    key = cloudWorkspaceKey(scope);
    await ensureCloudPrimaryWorkspace(root, scope);
    service = new WorkspaceService(root, { primaryDesignWorkspace: true });
  });

  afterEach(async () => {
    for (const bridge of clients.splice(0)) bridge.dispose();
    expect(RuntimeClient.prototype.request).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    resetWorkspaceDesignApisForTests();
    forgetDesignDirectoryName(root);
    closeState();
    setStateRootForTesting(null);
    await rm(temporary, { recursive: true, force: true });
  });

  it("lets a viewer preview cloud frames while only an editor moves several frames in one write", async () => {
    const owner = client("device-owner");
    const { frame } = await initialize(owner.bridge);
    const second = await bridgeDesignCreateFrame(owner.bridge, key, "Second frame");
    // Transport fixture: a PNG header of the requested raster size.
    const capture = await startDesignCaptureService(async (input) => {
      const bytes = Buffer.alloc(24);
      Buffer.from("89504e470d0a1a0a", "hex").copy(bytes);
      bytes.write("IHDR", 12); bytes.writeUInt32BE(input.width, 16); bytes.writeUInt32BE(input.height, 20);
      return { bytes, renderer: "transport-fixture" };
    });
    setDesignCaptureConfig(capture);
    try {
      const viewer = client("device-viewer", "viewer").bridge;
      const snapshot = await bridgeDesignSnapshot(viewer, key);
      const current = snapshot.frames.find((candidate) => candidate.file === frame.file)!;
      const preview = await bridgeDesignPreview(viewer, key, {
        directoryId: snapshot.directoryId!, frame: frame.file, sourceVersion: current.sourceVersion,
        theme: null, maxDimension: 128,
      });
      expect(preview).toMatchObject({ sourceVersion: current.sourceVersion, mimeType: "image/png" });
      expect(Math.max("width" in preview ? preview.width : 0, "height" in preview ? preview.height : 0)).toBe(128);
      await expect(bridgeDesignPreview(viewer, key, {
        directoryId: snapshot.directoryId!, frame: frame.file, sourceVersion: "0".repeat(24), theme: null, maxDimension: 128,
      })).resolves.toEqual({ stale: true, sourceVersion: current.sourceVersion });
      const moves = snapshot.frames
        .filter((candidate) => [frame.file, second.frame.file].includes(candidate.file))
        .map((candidate) => {
          const from = { x: candidate.x, y: candidate.y, w: candidate.width, h: candidate.height, z: candidate.z };
          return { frame: candidate.file, from, to: { ...from, x: from.x + 10 } };
        });
      expect(moves).toHaveLength(2);
      await expect(bridgeDesignMoveFrames(viewer, key, moves)).rejects.toThrow(/actor/);
      const moved = await bridgeDesignMoveFrames(owner.bridge, key, moves);
      for (const move of moves)
        expect(moved.frames.find((candidate) => candidate.file === move.frame)).toMatchObject({ x: move.to.x });
    } finally { setDesignCaptureConfig(undefined); await capture.stop(); }
  });

  it("admits measured movement only for its exact source and scene geometry through the cloud bridge", async () => {
    const { bridge } = client("device-a");
    const { frame } = await initialize(bridge);
    const initial = (await bridgeDesignSnapshot(bridge, key)).frames.find(
      (candidate) => candidate.file === frame.file,
    )!;
    const geometry = {
      x: initial.x,
      y: initial.y,
      w: initial.width,
      h: initial.height,
      z: initial.z,
    };
    const opened = await bridgeDesignFoundationOpen(bridge, key, frame.file);
    const transaction = (revision: string, x: number): DesignTransaction => ({
      ...move(frame.file, revision, x),
      operations: [
        {
          operationId: "move",
          type: "frame.set-geometry",
          frame: frame.file,
          geometry: {
            x,
            y: geometry.y,
            width: geometry.w,
            height: geometry.h,
            z: geometry.z,
          },
        },
      ],
    });
    const moved = await bridgeDesignApplyTransaction(
      bridge,
      key,
      frame.file,
      transaction(opened.summary.revision, geometry.x + 1),
      false,
      { sourceVersion: initial.sourceVersion, geometry },
    );
    expect(moved.result?.receipt.status).toBe("applied");
    const fresh = await bridgeDesignFoundationOpen(bridge, key, frame.file);
    await expect(
      bridgeDesignApplyTransaction(
        bridge,
        key,
        frame.file,
        transaction(fresh.summary.revision, geometry.x + 8),
        false,
        { sourceVersion: initial.sourceVersion, geometry },
      ),
    ).rejects.toThrow(/geometry changed/);
    await expect(
      bridgeDesignApplyTransaction(
        bridge,
        key,
        frame.file,
        transaction(fresh.summary.revision, geometry.x + 8),
        false,
        { sourceVersion: "f".repeat(24) },
      ),
    ).rejects.toThrow(/source.*changed/);
    expect(
      (await bridgeDesignSnapshot(bridge, key)).frames.find(
        (candidate) => candidate.file === frame.file,
      )?.x,
    ).toBe(geometry.x + 1);
  });

  it("discovers, initializes, edits and commits the VM checkout through the cloud bridge", async () => {
    const { bridge } = client("device-a");
    const head = git("rev-parse", "HEAD");
    const index = git("write-tree");
    expect(
      (await bridgeDesignListDirectories(bridge, key)).target?.exists,
    ).toBe(false);
    const { frame, directory } = await initialize(bridge);
    const listing = await bridgeDesignListDirectories(bridge, key);
    expect(listing.target).toEqual({ directory, exists: true });
    expect(
      await readFile(path.join(root, directory, "meta/design.toml"), "utf8"),
    ).toContain("version = 3");
    const opened = await bridgeDesignFoundationOpen(bridge, key, frame.file);
    const nodeId = /<main data-oid="([^"]+)"/.exec(frame.source)![1]!;
    const transaction: DesignTransaction = {
      ...move(frame.file, opened.summary.revision, 42),
      operations: [
        {
          operationId: "style",
          type: "node.set-styles",
          nodeId,
          styles: { padding: "48px", transition: "opacity 200ms" },
          scope: "auto",
          responsiveContext: "base",
          stateContext: "default",
        },
        {
          operationId: "motion",
          type: "keyframes.set",
          file: "tokens.css",
          name: "fade",
          keyframes: [
            { offset: 0, styles: { opacity: "0" } },
            { offset: 100, styles: { opacity: "1" } },
          ],
        },
      ],
    };
    const edited = await bridgeDesignApplyTransaction(
      bridge,
      key,
      frame.file,
      transaction,
    );
    expect(designWorkspaceSnapshotMatchesPath(edited.snapshot, key)).toBe(true);
    expect(edited.result?.receipt.actor).toEqual({
      kind: "human",
      id: `cloud:${userId}:device-a`,
    });
    const source = await readFile(
      path.join(root, directory, frame.file),
      "utf8",
    );
    expect(source).toContain("padding:48px");
    expect(source).toContain("opacity 200ms");
    expect(
      await readFile(path.join(root, directory, "tokens.css"), "utf8"),
    ).toContain("@keyframes fade");
    await bridgeDesignSave(bridge, key);
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(git("write-tree")).toBe(index);
    const status = await workspaceOp(bridge, "git.status", {
      workspaceId: key,
    });
    expect(JSON.stringify(status)).toContain(`${directory}/${frame.file}`);
    await workspaceOp(bridge, "git.stage", {
      workspaceId: key,
      paths: [directory, ".gitignore"],
    });
    const diff = await workspaceOp(bridge, "git.diff", {
      workspaceId: key,
      filePath: `${directory}/${frame.file}`,
      mode: "index-vs-head",
    });
    expect(JSON.stringify(diff)).toContain("padding:48px");
    const staged = git("write-tree");
    await workspaceOp(bridge, "git.commit", {
      workspaceId: key,
      message: "Cloud Design edit",
    });
    expect(git("rev-parse", "HEAD^{tree}")).toBe(staged);
    expect(git("show", `HEAD:${directory}/${frame.file}`)).toContain(
      "padding:48px",
    );
    expect(
      git("worktree", "list", "--porcelain").match(/^worktree /gm),
    ).toHaveLength(1);
  });

  it("opens cloud frame verification and routes both shell and bridge captures to the admitted host", async () => {
    const { frame, directory } = await initialize(client("manager").bridge);
    const bridge = client("developer", "developer").bridge;
    // Transport fixture only: the v4 qualifier must prove actual sandboxed
    // Chromium pixels separately. This proves source/identity/host routing.
    const capture = await startDesignCaptureService(async input => {
      const bytes = Buffer.alloc(24);
      Buffer.from("89504e470d0a1a0a", "hex").copy(bytes);
      bytes.write("IHDR", 12); bytes.writeUInt32BE(input.width, 16); bytes.writeUInt32BE(input.height, 20);
      return { bytes, renderer: "transport-fixture" };
    });
    setDesignCaptureConfig(capture);
    try {
      const snapshot = await bridgeDesignSnapshot(bridge, key);
      const directoryId = snapshot.directoryId!;
      const opened = await openDesignFramePreview(bridge, key, directoryId, frame.file);
      expect(opened.reference).toMatchObject({ workspaceId: key, directoryId, frame: frame.file });
      expect(opened.verification?.captureAvailable).toBe(true);
      expect((await fetch(opened.previewUrl)).status).toBe(200);
      const inspected = await workspaceOp(bridge, "design.context.inspect", { workspaceId: key, reference: opened.reference }) as { reference: { workspaceId: string }; verification: { captureAvailable: boolean } };
      expect(inspected.reference.workspaceId).toBe(key);
      expect(inspected.verification.captureAvailable).toBe(true);
      const contextReference = await createDesignFrameContext(bridge, key, frame.file, undefined, directoryId);
      expect(await inspectDesignFrameContext(bridge, contextReference)).toMatchObject({ status: "ready", reference: contextReference });
      const contextCapture = await captureDesignFrameContext(bridge, contextReference);
      expect(contextCapture.reference).toEqual(contextReference);
      expect(Buffer.from(contextCapture.data, "base64").readUInt32BE(16)).toBeGreaterThan(0);
      await expect(captureDesignFrameContext(client("prompter", "prompter").bridge, contextReference)).rejects.toThrow(/actor/);
      await expect(createDesignFrameContext(client("prompter", "prompter").bridge, key, frame.file)).rejects.toThrow(/actor/);
      await expect(workspaceOp(bridge, "design.context.capture", { workspaceId: key, reference: { ...contextReference, workspaceId: "foreign" } })).rejects.toThrow();
      // The host-local route still opens its own native reference unchanged.
      const local = await service.handle("design.verification.open", { workspaceId: "local-main", directoryId, frame: frame.file }) as typeof opened;
      expect(local.reference.workspaceId).toBe("local-main");
      expect((await fetch(local.previewUrl)).status).toBe(200);
      const output = path.join(root, ".context", "capture.png");
      expect(await runDesignVerificationCli(["capture", "--url", opened.verification!.url,
        "--frame", frame.file, "--output", output], () => {})).toBe(0);
      expect((await readFile(output)).readUInt32BE(16)).toBeGreaterThan(0);
      const foundation = await bridgeDesignFoundationOpen(bridge, key, frame.file);
      const result = await workspaceOp(bridge, "design.capture", { workspaceId: key,
        frame: frame.file, expectedRevision: foundation.summary.revision, width: 80, height: 48 }) as { data: string };
      expect(Buffer.from(result.data, "base64").readUInt32BE(16)).toBe(80);
      expect(await readFile(path.join(root, directory, frame.file), "utf8")).toBe(frame.source);
      await expect(openDesignFramePreview(client("prompter", "prompter").bridge, key, directoryId, frame.file)).rejects.toThrow(/actor/);
      await expect(service.handle("design.verification.open", { workspaceId: "local-main", directoryId, frame: frame.file },
        { remote: true, hostLocalResources: false })).rejects.toThrow();
    } finally { setDesignCaptureConfig(undefined); await capture.stop(); }
  });

  it("reads legacy root registration without migration or creating a replacement", async () => {
    const directory = "Existing Design";
    await mkdir(path.join(root, directory));
    const manifest = serializeDesignRegistration("design_legacy_cloud");
    const canvas = JSON.stringify({
      version: 1,
      id: "main",
      title: "Existing",
      frames: {
        home: {
          kind: "html",
          source: "home.html",
          title: "Home",
          x: 0,
          y: 0,
          width: 400,
          height: 300,
        },
      },
    });
    await writeFile(path.join(root, directory, "design.toml"), manifest);
    await writeFile(path.join(root, directory, "canvas.json"), canvas);
    await writeFile(
      path.join(root, directory, "home.html"),
      "<!doctype html><p>Existing frame</p>",
    );
    const { bridge } = client("device-a");
    expect((await bridgeDesignListDirectories(bridge, key)).target).toEqual({
      directory,
      exists: true,
    });
    const snapshot = await bridgeDesignSnapshot(bridge, key);
    expect(designWorkspaceSnapshotMatchesPath(snapshot, key)).toBe(true);
    expect(snapshot).toMatchObject({
      directoryId: "design_legacy_cloud",
      frames: [{ file: "home.html" }],
    });
    expect(
      await readFile(path.join(root, directory, "design.toml"), "utf8"),
    ).toBe(manifest);
    expect(
      await readFile(path.join(root, directory, "canvas.json"), "utf8"),
    ).toBe(canvas);
  });

  it("shares confirmed edits across devices while rejecting stale CAS and cross-device undo", async () => {
    const a = client("device-a").bridge;
    const b = client("device-b", "developer").bridge;
    const { frame } = await initialize(a);
    const other = await bridgeDesignCreateFrame(a, key, "Other frame");
    const sources = async () =>
      Object.fromEntries(
        (await bridgeDesignSnapshot(a, key)).frames.map((frame) => [
          frame.file,
          frame.sourceVersion,
        ]),
      );
    const staleSources = await sources();
    const { summary } = await bridgeDesignFoundationOpen(a, key, frame.file);
    await bridgeDesignApplyTransaction(
      a,
      key,
      frame.file,
      move(frame.file, summary.revision, 42),
    );
    expect((await bridgeDesignSnapshot(b, key)).frames[0]?.x).toBe(42);
    await expect(
      bridgeDesignApplyTransaction(
        b,
        key,
        frame.file,
        move(frame.file, summary.revision, 84),
      ),
    ).rejects.toThrow(/changed|revision/i);
    expect(
      (await bridgeDesignHistory(b, key, frame.file, "undo", await sources()))
        .result,
    ).toBeNull();
    await expect(
      bridgeDesignHistory(a, key, frame.file, "undo", staleSources),
    ).rejects.toThrow(/source changed/i);
    await expect(
      bridgeDesignHistory(a, key, frame.file, "undo", {}),
    ).rejects.toThrow(/source changed/i);
    expect((await bridgeDesignSnapshot(a, key)).frames[0]?.x).toBe(42);
    // History targets the last edited frame, independently of current focus.
    await bridgeDesignHistory(
      a,
      key,
      other.frame.file,
      "undo",
      await sources(),
    );
    expect((await bridgeDesignSnapshot(b, key)).frames[0]?.x).toBe(frame.x);
    await bridgeDesignHistory(a, key, null, "redo", await sources());
    expect((await bridgeDesignSnapshot(b, key)).frames[0]?.x).toBe(42);
    const prompter = client("device-c", "prompter").bridge;
    expect((await bridgeDesignSnapshot(prompter, key)).frames[0]?.x).toBe(42);
    await expect(
      bridgeDesignCreateFrame(prompter, key, "Refused"),
    ).rejects.toThrow(/actor/);
    await expect(
      workspaceOp(b, "design.initialize", { workspaceId: key }),
    ).rejects.toThrow(/actor/);
  });

  it("renders checkout assets through srcDoc and observes external source edits after a new read", async () => {
    const { bridge } = client("device-a");
    const { frame, directory } = await initialize(bridge);
    const file = path.join(root, directory, frame.file);
    await writeFile(file, frame.source.replace("Cloud frame", "External edit"));
    const refreshed = await bridgeDesignFrame(bridge, key, frame.file);
    expect(refreshed.sourceVersion).not.toBe(frame.sourceVersion);
    expect(refreshed.srcDoc).toContain("External edit");
    const image = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZAAAAABJRU5ErkJggg==",
      "base64",
    );
    await writeFile(path.join(root, directory, "assets/pixel.png"), image);
    const inserted = await bridgeDesignInsertAsset(bridge, key, {
      frame: frame.file,
      sourceVersion: refreshed.sourceVersion,
      assetPath: "assets/pixel.png",
      x: 5,
      y: 5,
    });
    expect(designWorkspaceSnapshotMatchesPath(inserted.snapshot, key)).toBe(
      true,
    );
    expect(inserted.mutation.frame.srcDoc).toContain("data:image/png;base64,");
    expect(inserted.mutation.frame.source).toContain("../assets/pixel.png");
    expect(await readFile(file, "utf8")).toContain("../assets/pixel.png");
    resetWorkspaceDesignApisForTests();
    service = new WorkspaceService(root, { primaryDesignWorkspace: true });
    const reconnect = client("device-a").bridge;
    const snapshot = await bridgeDesignSnapshot(reconnect, key);
    expect(designWorkspaceSnapshotMatchesPath(snapshot, key)).toBe(true);
    expect(snapshot.frames[0]?.sourceVersion).toBe(
      inserted.mutation.frame.sourceVersion,
    );
  });

  it("uploads an image as an actor-attributed checked edit shared with other devices and Git", async () => {
    const { bridge: owner } = client("device-a");
    const { frame, directory } = await initialize(owner);
    const { bridge } = client("device-b", "developer");
    const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 4, 0, 0, 0, 181, 28, 12, 2, 0, 0, 0, 11, 73, 68, 65, 84, 120, 218, 99, 252, 255, 31, 0, 2, 235, 1, 245, 105, 122, 100, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);
    const input = { workspaceId: key, directoryId: (await bridgeDesignSnapshot(bridge, key)).directoryId,
      frame: frame.file, sourceVersion: frame.sourceVersion, name: "pixel.png", mimeType: "image/png", data: image.toString("base64"), x: 8, y: 12 };
    const head = git("rev-parse", "HEAD");
    const index = git("write-tree");
    const result = await workspaceOp(bridge, "design.asset.upload", input) as {
      assetPath: string; receipt: { actor: unknown }; snapshot: DesignWorkspaceSnapshotWire;
    };
    expect(result.receipt.actor).toEqual({ kind: "human", id: `cloud:${userId}:device-b` });
    expect(result.assetPath).toMatch(/^assets\/[a-f0-9]{64}\.png$/);
    expect(await readFile(path.join(root, directory, result.assetPath))).toEqual(image);
    expect((await bridgeDesignFrame(owner, key, frame.file)).srcDoc).toContain("data:image/png;base64,");
    expect((await bridgeDesignSnapshot(owner, key)).assets.map(asset => asset.path)).toContain(result.assetPath);
    expect(git("ls-files", "--others", "--exclude-standard")).toContain(`${directory}/${result.assetPath}`);
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(git("write-tree")).toBe(index);
    // A stale retry cannot write another image/layer. Undo/redo keep the shared asset for other references.
    await expect(workspaceOp(bridge, "design.asset.upload", input)).rejects.toThrow(/changed/);
    const versions = async () => Object.fromEntries((await bridgeDesignSnapshot(bridge, key)).frames.map(({file, sourceVersion}) => [file, sourceVersion]));
    await bridgeDesignHistory(bridge, key, null, "undo", await versions());
    expect((await bridgeDesignFrame(owner, key, frame.file)).source).not.toContain(result.assetPath);
    expect(await readFile(path.join(root, directory, result.assetPath))).toEqual(image);
    await bridgeDesignHistory(bridge, key, null, "redo", await versions());
    expect((await bridgeDesignFrame(owner, key, frame.file)).source).toContain(result.assetPath);
    const prompter = client("device-c", "prompter").bridge;
    await expect(workspaceOp(prompter, "design.asset.upload", input)).rejects.toThrow(/actor/);
    await expect(new WorkspaceService(root).handle("design.asset.upload", { ...input, workspaceId: "local-main" }))
      .rejects.toThrow(/cloud/);
  });

  it("lets developers keep the person's style builds live and refuses prompters", async () => {
    const developer = client("device-d", "developer").bridge;
    await initialize(client("device-a").bridge);
    // No builds are set up, so presence starts nothing; the route and role are what matter.
    await expect(bridgeDesignStyleBuildPresence(developer, key, true)).resolves.toBeUndefined();
    await expect(bridgeDesignStyleBuildPresence(developer, key, false)).resolves.toBeUndefined();
    const prompter = client("device-c", "prompter").bridge;
    await expect(bridgeDesignStyleBuildPresence(prompter, key, true)).rejects.toThrow(/actor/);
  });

  it("does not replay an edit after its acknowledgement is lost", async () => {
    const { bridge, request } = client("device-a");
    const { frame } = await initialize(bridge);
    const { summary } = await bridgeDesignFoundationOpen(
      bridge,
      key,
      frame.file,
    );
    const dispatch = request.getMockImplementation()!;
    request.mockImplementationOnce(async (message) => {
      await dispatch(message);
      throw new Error("WebSocket closed before the response arrived");
    });
    await expect(
      bridgeDesignApplyTransaction(
        bridge,
        key,
        frame.file,
        move(frame.file, summary.revision, 42),
      ),
    ).rejects.toThrow(/closed/);
    expect(
      request.mock.calls.filter(
        ([message]) =>
          message.type === "WORKSPACE_REQUEST" &&
          message.op === "design.transaction.apply",
      ),
    ).toHaveLength(1);
    const observer = client("device-b").bridge;
    const snapshot = await bridgeDesignSnapshot(observer, key);
    expect(snapshot.frames[0]?.x).toBe(42);
    // One Undo returns to the original geometry, proving one history entry.
    await bridgeDesignHistory(
      bridge,
      key,
      frame.file,
      "undo",
      Object.fromEntries(
        snapshot.frames.map((frame) => [frame.file, frame.sourceVersion]),
      ),
    );
    expect((await bridgeDesignSnapshot(observer, key)).frames[0]?.x).toBe(
      frame.x,
    );
  });

  it("previews and registers an existing VM folder through the lifecycle bridge", async () => {
    const { bridge } = client("device-a");
    const reader = client("device-b", "prompter").bridge;
    const developer = client("device-c", "developer").bridge;
    const head = git("rev-parse", "HEAD");
    const index = git("write-tree");
    const source =
      "<!doctype html><html><head><title>Brand</title></head><body><main>Keep my source</main></body></html>";
    await mkdir(path.join(root, "Brand"));
    await writeFile(path.join(root, "Brand/home.html"), source);
    const preview = await bridgePreviewExistingDesignDirectory(
      reader,
      key,
      "Brand",
    );
    expect(preview).toMatchObject({
      directory: "Brand",
      metadataSource: "rebuild",
      frameCount: 1,
    });
    await expect(
      readFile(path.join(root, "Brand/meta/design.toml")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      bridgeAdoptDesignDirectory(developer, key, preview),
    ).rejects.toThrow(/Cloud actor/);
    await bridgeAdoptDesignDirectory(bridge, key, preview);
    const listing = await bridgeDesignListDirectories(bridge, key);
    expect(listing.directoryIds?.Brand).toBeTruthy();
    expect(
      await readFile(path.join(root, "Brand/page-1/home.html"), "utf8"),
    ).toBe(source);
    // The existing directory picker uses a generic settings write. Its
    // intentional remote denylist remains a separately audited product gap.
    await expect(workspaceOp(bridge, "settings.write", {
      layer: "workspace-local",
      repoRoot: key,
      patch: {
        design: { directory_id: listing.directoryIds!.Brand, directory: null },
      },
      confirmDesignDirectoryChange: true,
    })).rejects.toMatchObject({ code: "SETTINGS_REMOTE_KEY_DENIED" });
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(git("write-tree")).toBe(index);
  });

  it("pauses Design for a managed Git conflict and resumes after abort", async () => {
    const { bridge } = client("device-a");
    const { directory } = await initialize(bridge);
    await workspaceOp(bridge, "git.stage", {
      workspaceId: key,
      paths: [directory, ".gitignore"],
    });
    await workspaceOp(bridge, "git.commit", {
      workspaceId: key,
      message: "Design base",
    });
    const file = path.join(root, directory, "meta/design.toml");
    const manifest = await readFile(file, "utf8");
    git("checkout", "-qb", "conflicting-design");
    await writeFile(file, "# theirs\n" + manifest);
    git("add", directory);
    git("commit", "-qm", "Theirs");
    git("checkout", "-q", "main");
    await writeFile(file, "# ours\n" + manifest);
    git("add", directory);
    git("commit", "-qm", "Ours");
    await expect(
      workspaceOp(bridge, "git.merge", {
        workspaceId: key,
        branch: "conflicting-design",
      }),
    ).resolves.toEqual({
      merged: false,
      conflicts: [`${directory}/meta/design.toml`],
    });
    expect(
      await workspaceOp(bridge, "design.status", { workspaceId: key }),
    ).toMatchObject({
      operation: "merge",
      conflicts: [`${directory}/meta/design.toml`],
    });
    await expect(bridgeDesignSnapshot(bridge, key)).rejects.toThrow(
      /Design is paused/,
    );
    await expect(
      bridgeDesignCreateFrame(bridge, key, "Blocked"),
    ).rejects.toThrow(/Design is paused/);
    await workspaceOp(bridge, "git.abort", { workspaceId: key });
    expect((await bridgeDesignSnapshot(bridge, key)).frames).toHaveLength(1);
  });
});
