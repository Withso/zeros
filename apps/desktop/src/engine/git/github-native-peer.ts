import { spawn } from "node:child_process";
import type { Socket } from "node:net";

/** Terminal sockets share a Unix UID. Filesystem mode alone is insufficient:
 * require the kernel's connecting PID to descend from this exact PTY leader.
 * The cloud engine runs Node/Linux; unsupported transports fail closed. The
 * short trusted Python probe receives only the connected fd and public PID,
 * with no engine environment, credential or caller-provided code. */
export async function nativeGithubTerminalPeer(
  socket: Socket,
  leader: number,
): Promise<boolean> {
  const fd = (socket as Socket & { _handle?: { fd?: number } })._handle?.fd;
  if (
    process.platform !== "linux" ||
    !Number.isSafeInteger(fd) ||
    fd! < 0 ||
    !Number.isSafeInteger(leader) ||
    leader <= 0
  )
    return false;
  return new Promise((resolve) => {
    const child = spawn(
      "/usr/bin/python3",
      ["-I", "-c", PROBE, String(leader)],
      {
        env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
        stdio: ["ignore", "pipe", "ignore", fd!],
      },
    );
    let output = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), 2000);
    child.stdout?.on("data", (data: Buffer) => {
      output += data.toString();
      if (output.length > 16) child.kill("SIGKILL");
    });
    child.on("error", () => {
      clearTimeout(timeout);
      resolve(false);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve(code === 0 && output === "admitted");
    });
  });
}
const PROBE = `import socket,struct,sys
s=socket.socket(fileno=3)
pid,uid,gid=struct.unpack('3i',s.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
leader=int(sys.argv[1])
def stat(pid):
 with open('/proc/'+str(pid)+'/stat') as f: return f.read().rsplit(')',1)[1].split()
original=stat(leader)[19]
for _ in range(128):
 if pid==leader:
  if stat(leader)[19]==original: print('admitted',end='')
  break
 if pid<=1: break
 pid=int(stat(pid)[1])
`;
