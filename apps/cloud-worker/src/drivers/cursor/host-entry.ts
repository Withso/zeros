import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Agent } from "@cursor/sdk";
import { CursorHost } from "./host";
import { CURSOR_VERSION, type HostEvent, type HostRequest, type HostResponse, type OpenParams, type PromptParams } from "./native-types";

const require = createRequire(import.meta.url);
const manifest = join(dirname(require.resolve("@cursor/sdk")), "../../package.json");
if (require(manifest).version !== CURSOR_VERSION || !process.send || !process.env.CURSOR_API_KEY) throw new Error("Invalid Cursor host runtime.");
let pendingBytes = 0, output = Promise.resolve();
const disconnect = () => { if (process.connected) process.disconnect!(); };
function send(frame: HostEvent | HostResponse): Promise<void> {
  const bytes = Buffer.byteLength(JSON.stringify(frame));
  if (bytes > 16 * 1024 * 1024 || pendingBytes + bytes > 32 * 1024 * 1024) {
    disconnect(); return Promise.reject(new Error("Cursor host output exceeded its limit."));
  }
  pendingBytes += bytes;
  const delivery = output.then(() => new Promise<void>((resolve, reject) => {
    if (!process.connected) return reject(new Error("Cursor host disconnected."));
    process.send!(frame, error => error ? reject(error) : resolve());
  }));
  // Losing a terminal event cannot leave a healthy-looking parent waiting.
  // Disconnect causes the parent to fail the turn and reap this process group.
  output = delivery.catch(disconnect);
  return delivery.finally(() => { pendingBytes -= bytes; });
}
const host = new CursorHost(Agent, send, process.env.CURSOR_API_KEY);
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
process.on("message", raw => {
  if (Buffer.byteLength(JSON.stringify(raw)) > 16 * 1024 * 1024) { disconnect(); return; }
  const message = record(raw);
  if (!Number.isSafeInteger(message.id) || (message.id as number) < 1 || typeof message.method !== "string") return;
  const request = message as unknown as HostRequest, params = record(request.params);
  void (async () => {
    try {
      let value: unknown;
      switch (request.method) {
        case "open":
          if (typeof params.cwd !== "string" || !params.cwd.startsWith("/") || typeof params.model !== "string" ||
              (params.nativeSessionId !== undefined && typeof params.nativeSessionId !== "string")) throw new Error("Invalid Cursor session request.");
          value = await host.open(params as unknown as OpenParams); break;
        case "prompt":
          if (typeof params.turnId !== "string" || typeof params.model !== "string" || typeof record(params.content).text !== "string") throw new Error("Invalid Cursor prompt request.");
          value = await host.prompt(params as unknown as PromptParams); break;
        case "steer":
          if (typeof params.turnId !== "string" || typeof params.text !== "string") throw new Error("Invalid Cursor steer request.");
          value = await host.steer(params.turnId, params.text); break;
        case "interrupt":
          if (typeof params.turnId !== "string") throw new Error("Invalid Cursor interrupt request.");
          value = await host.interrupt(params.turnId); break;
        default: throw new Error("Unsupported Cursor host request.");
      }
      await send({ t: "reply", id: request.id, value });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Cursor request failed.";
      await send({ t: "reply", id: request.id, error: message.split(process.env.CURSOR_API_KEY!).join("[redacted]") });
    }
  })().catch(disconnect);
});
process.once("disconnect", () => { void host.dispose().finally(() => process.exit(0)); });
process.once("SIGTERM", () => { void host.dispose().finally(() => process.exit(0)); });
