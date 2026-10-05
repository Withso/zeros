import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { BoundaryRequest } from "../types";

const fixture = vi.hoisted(() => ({ missingLauncher: false, directory: "/opt/qualified-runtime", inspected: [] as string[] }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  // The image owns the entire ancestor chain. Hosted CI's /opt permissions
  // belong to its tool cache and must not determine this synthetic image.
  const directories = () => {
    const result = new Set(["/", "/usr", "/usr/bin"]);
    for (let current = fixture.directory; current !== "/"; current = current.slice(0, current.lastIndexOf("/")) || "/") result.add(current);
    return result;
  };
  const virtual = (value: unknown) => directories().has(String(value)) || String(value).startsWith(fixture.directory + "/") || String(value) === "/usr/bin/podman";
  const realpathSync = Object.assign((value: Parameters<typeof fs.realpathSync>[0]) => virtual(value) ? String(value) : fs.realpathSync(value), { native: fs.realpathSync.native });
  return { ...fs, realpathSync,
    existsSync: (value: Parameters<typeof fs.existsSync>[0]) => virtual(value) || fs.existsSync(value),
    lstatSync: (value: Parameters<typeof fs.lstatSync>[0]) => {
      fixture.inspected.push(String(value));
      if (!virtual(value)) return fs.lstatSync(value);
      if (fixture.missingLauncher && String(value).endsWith("cloud-container-worker.mjs")) throw new Error("missing image helper");
      const directory = directories().has(String(value));
      return { uid: 0, mode: 0o555, nlink: 1, isFile: () => !directory, isDirectory: () => directory, isSymbolicLink: () => false };
    },
  };
});

describe.runIf(process.platform === "linux")("immutable cloud helper resolution", () => {
  it.each(["/opt/qualified-runtime", `/opt/zeros-infra/r1-${"a".repeat(64)}/worker/apps/desktop/src/engine/agents/containment`])("qualifies a customer checkout using deployment helpers at %s", async directory => {
    fixture.directory = directory;
    const { ZsrExecutionBoundary } = await import("../zsr-boundary");
    fixture.inspected.length = 0;
    fixture.missingLauncher = false;
    const make = () => new ZsrExecutionBoundary({
      projectRoot: "/srv/zeros/workspace",
      ripgrepPath: process.execPath,
      cloudWorker: { uid: 10001, gid: 10001 },
      cloudWorkerToolchain: { supervisor: `${directory}/zsr-supervisor.mjs`, node: process.execPath, bwrap: "/usr/bin/bwrap", setpriv: "/usr/bin/setpriv" },
    });
    const request = { executionId: "fixture", actor: "agent-code", cwd: "/srv/zeros/workspace", workspaceRoot: "/srv/zeros/workspace", allowedLocalPorts: [] } as BoundaryRequest;
    expect(await make().probe(request)).toMatchObject({ available: true, secureNestedIsolation: true, reasons: [] });
    expect(fixture.inspected).toContain(path.join(directory, "cloud-container-worker.mjs"));
    expect(fixture.inspected.some(p => p.startsWith("/srv/zeros/workspace"))).toBe(false);
    fixture.missingLauncher = true;
    expect(await make().probe(request)).toMatchObject({ available: false, reasons: ["cloud container-worker launcher is unavailable"] });
  });
});
