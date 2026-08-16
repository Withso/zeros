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
  it("drops an ordinary human terminal to the workspace user", () => {
    expect(cloudHumanPtyLaunch(base, launch)).toEqual({
      command: "/usr/bin/setpriv",
      args: [
        "--reuid=10001",
        "--regid=10001",
        "--clear-groups",
        "--",
        "/bin/bash",
        "-l",
      ],
    });
  });

  it("keeps the trusted outer identity only long enough to launch ZSR", () => {
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
});
