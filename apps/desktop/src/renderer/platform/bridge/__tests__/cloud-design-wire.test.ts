import { describe, expect, it } from "vitest";
import { designWorkspaceSnapshotMatchesPath } from "../../../features/design-workspace/state/design-workspace-boot-cache";
import type { DesignWorkspaceSnapshotWire } from "../design-bridge";
import {
  cloudIncoming,
  cloudOutgoing,
  type CloudRuntimeScope,
} from "../cloud-runtime-wire";
import { cloudWorkspaceKey } from "../cloud-workspace-key";

const scope: CloudRuntimeScope = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  root: "/srv/zeros/workspace",
  engineWorkspaceId: "local-main",
};
const key = cloudWorkspaceKey(scope);
const snapshot: DesignWorkspaceSnapshotWire = {
  directoryId: "design_cloud",
  directory: "Product - Design",
  protocolCapability: null,
  frames: [],
  tokens: [],
  tokenSourceVersion: "revision",
  assets: [],
  lint: {
    workspacePath: scope.root,
    checkedFiles: ["page-1/home.html"],
    violations: [],
    healedOids: 0,
  },
};

describe("cloud Design snapshot ownership", () => {
  it("maps only typed Design context owners and rejects a foreign preview reference", () => {
    const native = { version: 1, workspaceId: scope.engineWorkspaceId, directoryId: "design_cloud",
      frame: "page-1/home.html", frameId: "frame_a", revision: "a".repeat(24) };
    for (const op of ["design.context.create", "design.context.inspect", "design.verification.open"]) {
      expect(cloudIncoming(scope, { type: "WORKSPACE_RESPONSE", op, result: { reference: native } }))
        .toMatchObject({ result: { reference: { ...native, workspaceId: key } } });
      expect(() => cloudIncoming(scope, { type: "WORKSPACE_RESPONSE", op,
        result: { reference: { ...native, workspaceId: "another-workspace" } } })).toThrow(/workspace/);
    }
    expect(cloudOutgoing(scope, { type: "WORKSPACE_REQUEST", op: "design.context.inspect",
      params: { workspaceId: key, reference: { ...native, workspaceId: key } } }))
      .toMatchObject({ params: { workspaceId: "local-main", reference: native } });
    expect(() => cloudOutgoing(scope, { type: "WORKSPACE_REQUEST", op: "design.context.inspect",
      params: { workspaceId: key, reference: native } })).toThrow(/workspace/);
    expect(native.workspaceId).toBe("local-main");
    expect(cloudIncoming(scope, { type: "WORKSPACE_RESPONSE", op: "file.read", result: { reference: native } }))
      .toMatchObject({ result: { reference: native } });
  });
  it.each([
    "design.previewExistingDirectory",
    "design.adoptDirectory",
    "design.renameDirectory",
    "design.removeDirectory",
  ])("binds %s to the admitted primary workspace", (op) => {
    expect(
      cloudOutgoing(scope, {
        type: "WORKSPACE_REQUEST",
        op,
        params: { repoRoot: key, folder: "Brand" },
      }),
    ).toMatchObject({
      params: {
        workspaceId: "local-main",
        repoRoot: scope.root,
        folder: "Brand",
      },
    });
    expect(
      cloudOutgoing(scope, {
        type: "WORKSPACE_REQUEST",
        op,
        params: { repoRoot: scope.root, workspaceId: "another-workspace" },
      }),
    ).toMatchObject({ params: { workspaceId: "another-workspace" } });
  });

  it.each([
    "design.snapshot",
    "design.initialize",
    "workspace.setMode",
    "design.transaction.apply",
    "design.history.undo",
    "design.history.redo",
    "design.frame.create",
    "design.page.create",
    "design.node.styles",
  ])("presents the %s reply in its admitted cloud checkout", (op) => {
    const response = cloudIncoming(scope, {
      type: "WORKSPACE_RESPONSE",
      op,
      result: { snapshot },
    }).result as { snapshot: DesignWorkspaceSnapshotWire };

    expect(designWorkspaceSnapshotMatchesPath(response.snapshot, key)).toBe(
      true,
    );
    expect(response.snapshot.lint.workspacePath).toBe(key);
    const other = cloudWorkspaceKey({
      ...scope,
      workspaceId: "33333333-3333-4333-8333-333333333333",
    });
    expect(designWorkspaceSnapshotMatchesPath(response.snapshot, other)).toBe(
      false,
    );
    expect(response.snapshot.frames).toBe(snapshot.frames);
    expect(response.snapshot.lint.checkedFiles).toBe(
      snapshot.lint.checkedFiles,
    );
    expect(snapshot.lint.workspacePath).toBe(scope.root);
  });

  it("scopes mutation and explicit lint reports without rewriting authored content", () => {
    const frame = {
      file: "page-1/home.html",
      source: `<p>${scope.root}</p>`,
      srcDoc: `<p>${scope.root}</p>`,
    };
    const mutation = { changed: true, frame, lint: snapshot.lint };
    const response = cloudIncoming(scope, {
      type: "WORKSPACE_RESPONSE",
      op: "design.node.html",
      result: { snapshot, mutation },
    }).result as { mutation: typeof mutation };
    expect(response.mutation.lint.workspacePath).toBe(key);
    expect(response.mutation.frame).toBe(frame);
    expect(
      cloudIncoming(scope, {
        type: "WORKSPACE_RESPONSE",
        op: "design.lint",
        result: { report: snapshot.lint },
      }),
    ).toMatchObject({ result: { report: { workspacePath: key } } });
  });

  it.each(["/another/checkout", `${scope.root}/nested`, "local-main"])(
    "does not relabel a snapshot from %s as the admitted checkout",
    (workspacePath) => {
      expect(() =>
        cloudIncoming(scope, {
          type: "WORKSPACE_RESPONSE",
          op: "design.snapshot",
          result: {
            snapshot: {
              ...snapshot,
              lint: { ...snapshot.lint, workspacePath },
            },
          },
        }),
      ).toThrow(/checkout/i);
    },
  );

  it("does not expose a VM-local resource capability to the client", () => {
    expect(
      cloudIncoming(scope, {
        type: "WORKSPACE_RESPONSE",
        op: "design.snapshot",
        result: {
          snapshot: { ...snapshot, protocolCapability: "a".repeat(64) },
        },
      }),
    ).toMatchObject({ result: { snapshot: { protocolCapability: null } } });
  });

  it("does not reinterpret snapshot-shaped data from unrelated operations", () => {
    expect(
      cloudIncoming(scope, {
        type: "WORKSPACE_RESPONSE",
        op: "file.read",
        result: { snapshot },
      }),
    ).toMatchObject({ result: { snapshot } });
  });
});
