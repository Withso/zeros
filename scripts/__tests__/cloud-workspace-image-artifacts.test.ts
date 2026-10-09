import { describe, expect, it } from "vitest";
import { buildEngineImage } from "../cloud-workspace-validation/image";

describe("cloud image generated runtime artifacts", () => {
  it("uses one non-root engine account for checkout, state and capture in the portable recipe", () => {
    const { dockerfile } = buildEngineImage();
    expect(dockerfile).toContain("groupadd --gid 10003 zeros-engine");
    expect(dockerfile).toContain("useradd --uid 10003 --gid 10003");
    for (const uid of [10001, 10002, 10004]) expect(dockerfile).not.toContain(`useradd --uid ${uid}`);
    expect(dockerfile).toContain("chown -R 10003:10003 '/srv/zeros/files/workspace'");
    expect(dockerfile).toContain("chown -R 10003:10003 /srv/zeros/state");
    expect(dockerfile).toContain("chmod 0700 /srv/zeros/state /srv/zeros/state/workspaces");
    expect(dockerfile).toContain("install -d -o 10003 -g 10003 -m 0700 /srv/zeros/home/capture");
  });
  it("installs the SFTP helper required by the immutable package inventory", () => {
    const install = buildEngineImage().dockerfile.split("\n").find(line => line.startsWith("RUN apt-get install "));
    expect(install?.split(/\s+/)).toContain("openssh-sftp-server");
  });
  it("builds the neutral ripgrep asset before recording the deployable image", () => {
    const { dockerfile } = buildEngineImage();
    const build = dockerfile.indexOf("pnpm build:ripgrep");
    const attestation = dockerfile.indexOf("write-image-build-metadata.mjs /etc/zeros/image-build.json");
    expect(build).toBeGreaterThanOrEqual(0);
    expect(build).toBeLessThan(attestation);
    expect(dockerfile).toContain("/opt/zeros-runtime/lib/zeros/cloud-engine-launcher.mjs");
    expect(dockerfile).toContain("-o /opt/zeros-runtime/cloud-engine-namespace");
  });
  it("keeps broker entrypoints outside provider-owned /usr/local", () => {
    const { dockerfile, contextList } = buildEngineImage();
    const copies = dockerfile.split("\n").filter(line => line.startsWith("COPY ")).map(line => JSON.parse(line.slice(5)) as string[]);
    expect(copies.every(([,target]) => !target.startsWith("/usr/local/"))).toBe(true);
    for (const source of contextList) expect(source.archivePath).toMatch(/^sandbox\/[^/]+$/);
    expect(copies.some(([,target]) => target === "/opt/zeros-runtime/lib/zeros/setup-cloud-workspace.mjs")).toBe(true);
    expect(copies.some(([,target]) => target === "/opt/zeros-runtime/bin/start-engine.sh")).toBe(true);
    const entrypoint = dockerfile.split("\n").find(line => line.startsWith("ENTRYPOINT "));
    expect(JSON.parse(entrypoint!.slice(11))).toEqual(["/opt/zeros-runtime/bin/node", "/opt/zeros-runtime/lib/zeros/cloud-worker-supervisor.mjs"]);
  });
});
