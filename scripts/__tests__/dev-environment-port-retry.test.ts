import net from "node:net";
import { expect, it } from "vitest";
import * as processes from "../dev-environment/processes.mjs";
it("retries a real bind collision with a fresh coherent attempt after the loser has exited", async () => {
  const server = net.createServer(); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port, attempts: number[] = [];
  try {
    const result = await (processes as any).withDevPortRetry(async (attempt: number) => {
      attempts.push(attempt);
      return processes.run(process.execPath, ["-e", `const s = require('node:net').createServer(); s.on('error', () => process.exit(98)); s.listen(${attempt === 0 ? port : 0}, '127.0.0.1', () => { console.log('bound'); s.close(); });`]);
    });
    expect(result).toBe("bound"); expect(attempts).toEqual([0, 1]);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
