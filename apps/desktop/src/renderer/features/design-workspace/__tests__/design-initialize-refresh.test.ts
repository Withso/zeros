import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  dbChangedIncludesOriginator,
  dbChangedKinds,
} from "../../../../engine/workspace/change-events";
import { MessageRouter } from "../../../../engine/transport/router";
import type { EngineMessage } from "../../../../engine/types";
import { cloudWorkspaceKey } from "../../../platform/bridge/cloud-workspace-key";
import { cloudIncoming } from "../../../platform/bridge/cloud-runtime-wire";
import { listWorkspaceFileListing } from "../../../platform/git";
import {
  loadWorkspaceFileListing,
  peekWorkspaceFileListing,
  resetWorkspaceFilesCacheForTests,
  type WorkspaceFileListing,
} from "../../../shell/workspace-files-cache";
import {
  getGitRefreshKeyForTests,
  resetGitRefreshKeysForTests,
  subscribeGitRefreshForTests,
  triggerGitRefreshForWorkspaceIdsForTests,
} from "../../../shell/use-git-refresh-key";

vi.mock("../../../platform/git", () => ({
  listWorkspaceFileListing: vi.fn(),
}));
vi.mock("../../../state/use-projects", () => ({
  notifyWorkspacesChanged: vi.fn(),
  notifyWorkspacesChangedForIds: vi.fn(),
}));

const cloud = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  root: "/srv/zeros/workspace",
  engineWorkspaceId: "local-main",
};
const otherCloud = cloudWorkspaceKey({
  organizationId: "33333333-3333-4333-8333-333333333333",
  workspaceId: "44444444-4444-4444-8444-444444444444",
});
const owners = [
  { label: "Personal Local", id: "personal-local", cwd: "/personal/repo" },
  { label: "organization Local", id: "organization-local", cwd: "/org/repo" },
  {
    label: "organization cloud",
    id: cloudWorkspaceKey(cloud),
    cwd: cloudWorkspaceKey(cloud),
  },
  { label: "another cloud owner", id: otherCloud, cwd: otherCloud },
];

beforeEach(() => {
  vi.clearAllMocks();
  resetGitRefreshKeysForTests();
  resetWorkspaceFilesCacheForTests();
});

describe("Design initialization refresh", () => {
  it.each(owners.slice(0, 3))(
    "updates warm Files and Changes for $label without refreshing a switched owner",
    async (owner) => {
      const listings = new Map<string, WorkspaceFileListing>();
      const original = { files: ["README.md"], designDirectories: [] };
      for (const target of owners) listings.set(target.cwd, original);
      const read = vi.mocked(listWorkspaceFileListing);
      read.mockImplementation(async (cwd) => listings.get(cwd)!);
      const confirmed = await Promise.all(
        owners.map((target) => loadWorkspaceFileListing(target.cwd)),
      );

      const listeners = owners.map(() => vi.fn());
      const stop = owners.map((target, index) =>
        subscribeGitRefreshForTests(target.cwd, listeners[index], target.id),
      );
      const versions = owners.map((target) =>
        getGitRefreshKeyForTests(target.cwd, target.id),
      );
      try {
        const cloudWorker = owner.id === cloudWorkspaceKey(cloud);
        const router = new MessageRouter();
        router.register({
          id: "initiator",
          kind: cloudWorker ? "cloud" : "local",
          close: () => {},
          send: (message) => {
            if (message.type !== "DB_CHANGED") return;
            const incoming = cloudWorker
              ? cloudIncoming(cloud, { ...message })
              : message;
            triggerGitRefreshForWorkspaceIdsForTests(
              incoming.workspaceIds as string[],
            );
          },
        });
        const peer = vi.fn();
        router.register({
          id: "peer",
          kind: "cloud",
          close: () => {},
          send: peer,
        });
        const directory = "repo - Design";
        const initialized = {
          files: [
            "README.md",
            `${directory}/meta/design.toml`,
            `${directory}/meta/canvas.json`,
            `${directory}/rules.md`,
          ],
          designDirectories: [directory],
        };
        listings.set(owner.cwd, initialized);
        const message = {
          id: "initialize-completed",
          timestamp: 0,
          source: "engine",
          type: "DB_CHANGED",
          kinds: dbChangedKinds("design.initialize", undefined, cloudWorker),
          workspaceIds: [cloudWorker ? cloud.engineWorkspaceId : owner.id],
        } as EngineMessage;
        if (dbChangedIncludesOriginator("design.initialize", cloudWorker)) {
          router.broadcast(message);
        } else {
          router.broadcastExcept("initiator", message);
        }

        // Confirmed data remains paintable until the exact owner's next read.
        expect(peekWorkspaceFileListing(owner.cwd)).toBe(
          confirmed[owners.indexOf(owner)],
        );
        expect(peer).toHaveBeenCalledOnce();
        await expect(loadWorkspaceFileListing(owner.cwd)).resolves.toEqual(
          initialized,
        );
        for (const [index, target] of owners.entries()) {
          if (target.id === owner.id) {
            expect(listeners[index]).toHaveBeenCalledOnce();
            expect(
              getGitRefreshKeyForTests(target.cwd, target.id),
            ).toBeGreaterThan(versions[index]);
          } else {
            expect(listeners[index]).not.toHaveBeenCalled();
            expect(getGitRefreshKeyForTests(target.cwd, target.id)).toBe(
              versions[index],
            );
            await expect(loadWorkspaceFileListing(target.cwd)).resolves.toBe(
              confirmed[index],
            );
          }
        }
        expect(read).toHaveBeenCalledTimes(owners.length + 1);
      } finally {
        for (const release of stop) release();
      }
    },
  );
});
