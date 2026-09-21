import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const race = vi.hoisted(() => ({
  files: new Map<number, string>(),
  target: "",
  armed: false,
}));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      const descriptor = actual.openSync(...args);
      if (args[1] === "wx") race.files.set(descriptor, String(args[0]));
      return descriptor;
    },
    closeSync: (descriptor: number) => {
      const file = race.files.get(descriptor);
      actual.closeSync(descriptor);
      race.files.delete(descriptor);
      if (file && race.armed) {
        race.armed = false;
        actual.unlinkSync(file);
        actual.symlinkSync(race.target, file);
      }
    },
  };
});
import { installCloudGithubCredentialPayload } from "../cloud-workspace-validation/sandbox/install-cloud-github-credential.mjs";
import { installCloudPreviewLinkPayload } from "../cloud-workspace-validation/sandbox/install-cloud-preview-links.mjs";

const roots: string[] = [];
afterEach(() => {
  race.armed = false;
  race.files.clear();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe("host credential projection races", () => {
  it.each(["github", "preview"])(
    "does not mutate a symlink substituted after closing the %s projection",
    (kind) => {
      const root = fs.mkdtempSync(
        path.join(os.tmpdir(), "zeros-projection-race-"),
      );
      roots.push(root);
      race.target = path.join(root, "canary");
      fs.writeFileSync(race.target, "unchanged", { mode: 0o644 });
      const now = Date.now();
      const shared = {
        version: 1,
        generation: "projection-generation-123456",
        issuedAt: now,
        expiresAt: now + 60_000,
      };
      const document =
        kind === "github"
          ? {
              ...shared,
              audience: "zeros-cloud-github-credential-v1",
              ownerSubjectSha256: "a".repeat(64),
              method: "pat",
              credential: null,
            }
          : {
              ...shared,
              audience: "zeros-cloud-preview-v1",
              links: [
                { port: 41000, signedUrl: "https://41000-preview.example/" },
              ],
            };
      race.armed = true;
      const install =
        kind === "github"
          ? installCloudGithubCredentialPayload
          : installCloudPreviewLinkPayload;
      install(Buffer.from(JSON.stringify(document)).toString("base64url"), {
        output: path.join(root, "projection.json"),
        expectedUid: fs.statSync(root).uid,
        expectedOwnerSubjectSha256: "a".repeat(64),
        now,
      });
      expect(fs.statSync(race.target).mode & 0o777).toBe(0o644);
      expect(fs.readFileSync(race.target, "utf8")).toBe("unchanged");
    },
  );
});
