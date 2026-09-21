import { describe, expect, it } from "vitest";
import {
  hasCloudEngineUserNamespace,
  isCloudDeploymentOwner,
  isCloudEngineIdMap,
  cloudEngineIdMapVersion,
  isReadOnlyCloudMount,
} from "../cloud-deployment-authority.mjs";

describe("cloud engine namespace authority", () => {
  it("adds only the private provider identity in the separate v3 map",()=>{
    const v2="0 10003 1\n10001 10001 2\n",v3=v2+"10004 10004 1\n";
    expect(cloudEngineIdMapVersion(v2)).toBe(2);expect(cloudEngineIdMapVersion(v3)).toBe(3);
    expect(isCloudEngineIdMap(v3)).toBe(true);
    for(const suffix of ["10004 0 1\n","10004 10004 2\n","10004 10004 1\n10005 10005 1\n"])
      expect(cloudEngineIdMapVersion(v2+suffix)).toBeNull();
  });
  it("admits exactly the engine, worker, and capture VM identities", () => {
    expect(
      isCloudEngineIdMap(
        "         0      10003          1\n     10001      10001          2\n",
      ),
    ).toBe(true);
    for (const value of [
      "0 0 4294967295\n",
      "0 10003 1\n",
      "0 10003 1\n10001 10001 3\n",
      "0 10003 1\n10001 0 2\n",
      "0 10003 1\n10001 10001 2\n65534 65534 1\n",
      "0 10003 1\n10001 10001 2 trailing\n",
      "0 10003 1\n10001 10001 2\0",
      null,
    ])
      expect(isCloudEngineIdMap(value)).toBe(false);
  });

  const mount = (id: number, directory: string, options: string) =>
    `${id} 1 0:1 / ${directory} ${options} - tmpfs tmpfs rw\n`;

  it("uses the deepest exact mount and its mount flags", () => {
    const table =
      mount(1, "/", "ro,nosuid") +
      mount(2, "/srv/zeros", "rw,nosuid") +
      mount(3, "/opt/zeros", "ro,nosuid") +
      mount(4, "/srv/zeros/public", "ro,nosuid");
    expect(isReadOnlyCloudMount("/opt/zeros/cli.js", table)).toBe(true);
    expect(isReadOnlyCloudMount("/srv/zeros/state/db", table)).toBe(false);
    expect(isReadOnlyCloudMount("/srv/zeros/public/settings", table)).toBe(
      true,
    );
    expect(
      isReadOnlyCloudMount("/srv/zeros/public-other/settings", table),
    ).toBe(false);
    expect(isReadOnlyCloudMount("/srv/zeros-other/file", table)).toBe(true);
  });

  it("rejects ambiguity, malformed evidence and aliases", () => {
    const root = mount(1, "/", "ro");
    for (const table of [
      "",
      "malformed",
      root + mount(2, "/", "rw"),
      root + mount(2, "/opt/../root", "ro"),
      root + mount(2, "/opt/\\999", "ro"),
    ])
      expect(isReadOnlyCloudMount("/opt/zeros/node", table)).toBe(false);
    for (const file of ["opt/zeros", "/opt/../etc/passwd", "/opt/node\0"])
      expect(isReadOnlyCloudMount(file, root)).toBe(false);
    expect(
      isReadOnlyCloudMount(
        "/opt/a b/node",
        root + mount(2, "/opt/a\\040b", "rw"),
      ),
    ).toBe(false);
  });

  it("does not turn an unmapped owner into local root authority", () => {
    expect(hasCloudEngineUserNamespace()).toBe(false);
    expect(isCloudDeploymentOwner("/usr/bin/node", 65534)).toBe(false);
    expect(isCloudDeploymentOwner("/usr/bin/node", 1000)).toBe(false);
    expect(isCloudDeploymentOwner("/usr/bin/node", 0)).toBe(true);
  });
});
