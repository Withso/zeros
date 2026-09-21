import { describe, expect, it, vi } from "vitest";
const image = vi.hoisted(() => {
  const commands: string[] = [];
  const copies = new Map<string, string>();
  const entrypoints: string[][] = [];
  const builder = {
    env: () => builder,
    runCommands: (...values: string[]) => {
      commands.push(...values);
      return builder;
    },
    addLocalFile: (source: string, target: string) => {
      copies.set(target, source);
      return builder;
    },
    workdir: () => builder,
    entrypoint: (value: string[]) => {
      entrypoints.push(value);
      return builder;
    },
  };
  return { builder, commands, copies, entrypoints };
});
vi.mock("@daytona/sdk", () => ({ Image: { base: () => image.builder } }));
import { buildEngineImage } from "../cloud-workspace-validation/image";

describe("cloud image generated runtime artifacts", () => {
  it("builds the ignored ZSR supervisor before recording the deployable image", () => {
    buildEngineImage();
    const build = image.commands.findIndex((command) =>
      command.includes("pnpm build:zsr-supervisor"),
    );
    const attestation = image.commands.findIndex((command) =>
      command.includes(
        "write-image-build-metadata.mjs /etc/zeros/image-build.json",
      ),
    );
    expect(build).toBeGreaterThanOrEqual(0);
    expect(build).toBeLessThan(attestation);
    expect(
      image.copies.has(
        "/opt/zeros-runtime/lib/zeros/cloud-engine-launcher.mjs",
      ),
    ).toBe(true);
    expect(
      image.commands.some((command) =>
        command.includes("-o /opt/zeros-runtime/cloud-engine-namespace"),
      ),
    ).toBe(true);
  });
  it("keeps version-2 broker entrypoints outside provider-owned /usr/local", () => {
    buildEngineImage();
    for (const target of image.copies.keys()) {
      expect(target.startsWith("/usr/local/")).toBe(false);
    }
    expect(
      image.copies.has(
        "/opt/zeros-runtime/lib/zeros/setup-cloud-workspace.mjs",
      ),
    ).toBe(true);
    expect(image.copies.has("/opt/zeros-runtime/bin/start-engine.sh")).toBe(
      true,
    );
    expect(image.entrypoints.at(-1)).toEqual([
      "/opt/zeros-runtime/bin/node",
      "/opt/zeros-runtime/lib/zeros/cloud-worker-supervisor.mjs",
    ]);
  });
});
