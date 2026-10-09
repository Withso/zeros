import { describe, expect, it } from "vitest";

import { cloudHumanPtyLaunch } from "../node-pty-spawn";

const base = {
  cwd: "/workspace/project",
  cols: 80,
  rows: 24,
  cloudWorkerIdentity: { uid: 10_001, gid: 10_001 },
  cloudWorkerSetprivPath: "/usr/bin/setpriv",
};
const launch = { command: "/bin/bash", args: ["-l"] };

describe("cloud PTY identity", () => {
  it("inherits the engine identity without selecting a legacy worker", () => {
    expect(cloudHumanPtyLaunch(base, launch)).toEqual(launch);
  });

  it("preserves the original owned-process wrapper", () => {
    expect(
      cloudHumanPtyLaunch(
        {
          ...base,
          wrapSpawn: (request) => request,
        },
        launch,
      ),
    ).toEqual(launch);
  });

  it("keeps Local terminal shell and login arguments unchanged", () => {
    expect(cloudHumanPtyLaunch({}, launch)).toEqual(launch);
  });

  it("does not execute a historical privilege-drop helper", () => {
    expect(cloudHumanPtyLaunch({ cloudWorkerIdentity: base.cloudWorkerIdentity }, launch)).toEqual(launch);
    expect(cloudHumanPtyLaunch({ ...base, cloudWorkerSetprivPath: "/srv/zeros/workspace/setpriv" }, launch)).toEqual(launch);
  });
});
