import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {EventEmitter} from "node:events";
import {Writable} from "node:stream";
import {createCloudRuntimeResolver} from "../../apps/desktop/src/engine/agents/containment/cloud-runtime-root.mjs";
import {cloudRuntimeFixture} from "../../apps/desktop/src/engine/agents/containment/__tests__/cloud-runtime-fixture";
import {launchCloudEngine} from "../cloud-workspace-validation/sandbox/cloud-engine-launcher.mjs";

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
it("keeps the resolved launch root when current switches before the native child starts",async()=>{
  const tree=cloudRuntimeFixture();
  try {
    const runtime=createCloudRuntimeResolver({filesystem:tree.filesystem}).resolve();
    const next=`r1-${"d".repeat(64)}`;
    tree.install(`/opt/zeros-infra/${next}`);
    const child=Object.assign(new EventEmitter(),{pid:123,exitCode:null,signalCode:null,kill:vi.fn(),unref:vi.fn(),
      stdio:[null,null,null,new Writable({write(_chunk,_encoding,done){done();setImmediate(()=>child.emit("exit",0));}})]});
    const launch=vi.fn(()=>{setImmediate(()=>child.emit("spawn"));return child;});
    const releaseView=vi.fn();
    await launchCloudEngine({runtime,source:{},signals:new EventEmitter(),spawnProcess:launch,
      scope:{prepare(){},attach(){},async retire(){}},
      prepare(selected:unknown){
        expect(selected).toBe(runtime);
        fs.unlinkSync(tree.physical("/opt/zeros/current"));tree.link("/opt/zeros/current",`../zeros-infra/${next}`);
        tree.write("/run/zeros/active-runtime.json",{...tree.descriptor,root:`/opt/zeros-infra/${next}`,runtimeId:next,manifestSha256:"d".repeat(64)},0o600);
        return {version:4,runtime,viewDirectory:"/run/zeros/view/runtime-32345678-1234-4234-8234-123456789abc",releaseView};
      }});
    expect(launch.mock.calls[0][0]).toBe(runtime.engineNamespace);
    expect(launch.mock.calls[0][1]).toContain(runtime.root);
    expect(launch.mock.calls[0][1]).not.toContain(`/opt/zeros-infra/${next}`);
    expect(releaseView).toHaveBeenCalledOnce();
  } finally {tree.dispose();}
});
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
      fs.chmodSync(race.target, 0o644);
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
