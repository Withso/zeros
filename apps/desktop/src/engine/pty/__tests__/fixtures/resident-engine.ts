import { ResidentPtyClient } from "../../resident-client";
import type { ResidentEngineAuthority } from "../../resident-protocol";

process.once("message", async (value: {
  socketPath: string; authority: ResidentEngineAuthority; sessionId: string;
  cwd: string; command: string;
}) => {
  try {
    const client = new ResidentPtyClient(value);
    await client.connect();
    const session = await client.create({ sessionId: value.sessionId, cwd: value.cwd,
      command: value.command, cols: 80, rows: 24, env: { PATH: "/usr/bin:/bin" } });
    process.send?.({ ok: true, pid: session.pid });
  } catch {
    process.send?.({ ok: false });
  }
});
