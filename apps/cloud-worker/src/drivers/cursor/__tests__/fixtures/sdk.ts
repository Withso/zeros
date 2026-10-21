import { setTimeout as delay } from "node:timers/promises";
import type { AgentOptions, SDKUserMessage } from "@cursor/sdk";
import type { Serializable } from "node:child_process";
import type { NativeRun, NativeSend } from "../../native-types";

/** Offline SDK double behind the real child host and IPC protocol. No test
 * hooks enter the shipped host; esbuild aliases this module in tests only. */
export class Agent {
  private sends = 0;
  private billed: unknown;
  constructor(readonly agentId: string, private options: AgentOptions, private resumed: boolean) {}
  static async create(options: AgentOptions) { return new Agent("native-agent", options, false); }
  static async resume(id: string, options: AgentOptions) { return new Agent(id, options, true); }
  close() {}
  async getUsage() { return this.billed; }
  async send(message: SDKUserMessage, options: NativeSend): Promise<NativeRun> {
    const fixture = JSON.parse(message.text) as {
      before?: Array<{ kind: string; value: unknown }>;
      frames?: Array<{ kind: string; value: unknown }>;
      result?: Record<string, unknown>; billed?: unknown;
      inspect?: boolean; hang?: boolean; sendHang?: boolean; sendDelay?: number;
      waitHang?: boolean; eof?: boolean; authError?: boolean; steer?: string; outputFailure?: boolean;
    };
    const id = `run-${++this.sends}`;
    this.billed = fixture.billed;
    const callbacks = async (frame: { kind: string; value: unknown }) => {
      if (frame.kind === "delta") await options.onDelta({ update: frame.value });
      if (frame.kind === "step") await options.onStep({ step: frame.value });
    };
    for (const frame of fixture.before ?? []) await callbacks(frame);
    if (fixture.sendDelay) await delay(fixture.sendDelay);
    if (fixture.sendHang) await new Promise(() => {});
    if (fixture.authError) throw new Error(`401 invalid api key: ${process.env.CURSOR_API_KEY}`);
    let release!: () => void, stopped = false;
    const done = new Promise<void>(resolve => { release = resolve; });
    return { id,
      stream: async function* () {
        if (fixture.eof) process.exit(0);
        for (const frame of fixture.frames ?? []) {
          if (stopped) break;
          if (frame.kind === "message") yield frame.value; else await callbacks(frame);
        }
        if (fixture.hang) { yield { type: "assistant", message: { content: [{ type: "text", text: "Ready" }] } }; await done; }
      },
      wait: async () => {
        if (fixture.waitHang) await new Promise(() => {});
        if (fixture.outputFailure) {
          const send = process.send!.bind(process);
          process.send = ((frame: Serializable, callback: (error: Error | null) => void) => {
            if ((frame as { kind?: string }).kind === "result") { queueMicrotask(() => callback(new Error("Synthetic IPC delivery failure"))); return false; }
            return send(frame, callback);
          }) as typeof process.send;
        }
        return { id, status: stopped ? "cancelled" : "finished", model: options.model, ...fixture.result,
          ...(fixture.inspect ? { result: JSON.stringify({ sends: this.sends, resumed: this.resumed, model: options.model,
            mode: options.mode, cwd: this.options.local?.cwd, local: this.options.local, images: message.images,
            ownLogin: !!process.env.CURSOR_API_KEY && process.env.CURSOR_API_KEY === this.options.apiKey,
            forbidden: ["ZEROS_WORKER_TOKEN", "ANTHROPIC_AUTH_TOKEN", "ZEROS_CLOUD_PROXY_TOKEN", "NODE_OPTIONS", "GH_TOKEN"].some(key => !!process.env[key]),
          }) } : {}),
        };
      },
      cancel: async () => { stopped = true; release(); },
      steer: async text => {
        if (text === "lost receipt") return new Promise(() => {});
        if (text !== "follow up\n\n.context/reference.md") throw new Error("Text blocks were lost.");
        return fixture.steer ?? "complete_delivered";
      },
    };
  }
}
