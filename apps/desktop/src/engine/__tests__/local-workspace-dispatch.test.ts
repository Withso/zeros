import { afterEach, describe, expect, it, vi } from "vitest";
import { ZerosEngine } from "../zeros-engine";
import type { EngineMessage } from "../types";
import type { TransportClient } from "../transport/types";
import {
  githubReadCanEdit,
  githubReadTransport,
} from "../git/github-read-context";
import { githubWriteCredential } from "../git/github-write-context";
import { scopedCloudGitAuthorEnvironment } from "../git/cloud-git-author";

afterEach(() => vi.restoreAllMocks());

describe("local sidecar Git dispatch", () => {
  it.each(["git.fetch", "git.pull", "git.push", "gh.prGet", "gh.branchList"])(
    "keeps %s free of cloud actor, grant and author requirements",
    async (op) => {
      const engine = new ZerosEngine({
        root: "/tmp/zeros-v2-test-local-dispatch",
        port: 29920,
      });
      const state = engine as unknown as {
        workspace: {
          lifecycleMutationWorkspaceId(): string | null;
          handle(): Promise<unknown>;
        };
        handleWorkspaceMessage(
          message: Extract<EngineMessage, { type: "WORKSPACE_REQUEST" }>,
          client: TransportClient,
        ): Promise<void>;
      };
      vi.spyOn(state.workspace, "lifecycleMutationWorkspaceId").mockReturnValue(
        null,
      );
      const handle = vi
        .spyOn(state.workspace, "handle")
        .mockImplementation(async () => {
          expect(githubReadTransport()).toBeUndefined();
          expect(githubReadCanEdit()).toBeUndefined();
          expect(githubWriteCredential()).toBeNull();
          expect(scopedCloudGitAuthorEnvironment()).toEqual({});
          return { ok: true };
        });
      const client: TransportClient = {
        id: "desktop",
        kind: "local",
        send: vi.fn(),
        close: vi.fn(),
      };
      const params = {
        workspaceId: "ws_local",
        remote: "origin",
        strategy: "rebase",
        autoStash: true,
      };

      await state.handleWorkspaceMessage(
        {
          type: "WORKSPACE_REQUEST",
          source: "browser",
          id: op,
          timestamp: 1,
          op,
          params,
        },
        client,
      );

      expect(handle).toHaveBeenCalledExactlyOnceWith(op, params, {
        hostLocalResources: true,
        remote: false,
        cloudWorker: false,
      });
      expect(client.send).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          type: "WORKSPACE_RESPONSE",
          requestId: op,
          op,
          result: { ok: true },
        }),
      );
    },
  );
});
