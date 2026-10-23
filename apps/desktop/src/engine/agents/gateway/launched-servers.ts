import { createHash } from "node:crypto";
import type { McpServerRegistration } from "../types";
import type { RepoTaskBoundaryFactory } from "../containment/types";
import { materializeMcpServerRegistration } from "../mcp-registration";
import { McpHttpLauncher } from "./http-launcher";

/** Explicit session admission owns these processes; form reads and HTTP
 * probes never launch a command. Retain only live configurations, with no
 * idle health checks or retries. */
export class LaunchedMcpServers {
  private readonly entries = new Map<string, { launcher: McpHttpLauncher; signature: string; cwd: string; owner: string; organization: boolean }>();
  private readonly flights = new Map<string, Promise<unknown>>();
  private readonly admissions = new Set<{ cwd: string; owner: string; organization: boolean; retired: boolean }>();
  private closed = false;
  constructor(private readonly boundaryFactory: RepoTaskBoundaryFactory) {}
  resolve(servers: McpServerRegistration[], cwd: string, env: Record<string, string>, owner: string, repoRoot: string, organization: boolean, signal?: AbortSignal): Promise<McpServerRegistration[]> {
    const admission = { cwd, owner, organization, retired: false };
    this.admissions.add(admission);
    const assertCurrent = () => {
      if (this.closed || admission.retired) throw new Error("MCP runtime changed. Try again.");
      signal?.throwIfAborted();
    };
    const run = async () => {
      assertCurrent();
      const output: McpServerRegistration[] = [];
      const wanted = new Set<string>();
      for (const server of servers) {
        if (server.transport !== "stdio" || !server.listenUrl) { output.push(server); continue; }
        const key = JSON.stringify([owner, cwd, server.name]); wanted.add(key);
        const materialized = materializeMcpServerRegistration(server, env);
        if (materialized.transport !== "stdio") throw new Error("Invalid MCP process configuration.");
        const processEnv = Object.fromEntries(Object.entries(env).filter(([name]) => !/^ZEROS_MCP_[A-F0-9]{32}_/.test(name) && name !== "ZEROS_LOCAL_DEVELOPMENT"));
        Object.assign(processEnv, materialized.env);
        const signature = createHash("sha256").update(JSON.stringify([server, cwd, processEnv])).digest("hex");
        let entry = this.entries.get(key);
        if (entry && entry.signature !== signature) { await entry.launcher.dispose(); this.entries.delete(key); entry = undefined; }
        assertCurrent();
        if (!entry) {
          if (this.entries.size >= 64) throw new Error("Too many running MCP processes.");
          entry = { signature, cwd, owner, organization, launcher: new McpHttpLauncher({ command: server.command,
            args: server.args, cwd: server.cwd, env: processEnv, listenUrl: server.listenUrl, workspaceRoot: cwd, repoRoot, boundaryFactory: this.boundaryFactory }) };
          this.entries.set(key, entry);
        }
        await entry.launcher.ensureRunning(signal);
        assertCurrent();
        output.push({ name: server.name, transport: "http", url: entry.launcher.endpoint });
      }
      for (const [key, entry] of this.entries) {
        if (entry.owner === owner && entry.cwd === cwd && !wanted.has(key)) {
          await entry.launcher.dispose(); this.entries.delete(key);
        }
      }
      assertCurrent();
      return output;
    };
    const previous = this.flights.get(owner) ?? Promise.resolve();
    const flight = previous.then(run, run);
    this.flights.set(owner, flight);
    void flight.finally(() => {
      this.admissions.delete(admission);
      if (this.flights.get(owner) === flight) this.flights.delete(owner);
    }).catch(() => {});
    return flight;
  }
  async removeWhere(matches: (entry: { cwd: string; owner: string; organization: boolean }) => boolean): Promise<void> {
    // Include queued admissions that have not created an entry yet, while
    // leaving unrelated workspace and owner lifetimes intact.
    for (const admission of this.admissions) if (matches(admission)) admission.retired = true;
    await Promise.all([...this.entries].filter(([, entry]) => matches(entry)).map(async ([key, entry]) => {
      await entry.launcher.dispose();
      if (this.entries.get(key) === entry) this.entries.delete(key);
    }));
  }
  async stop(): Promise<void> { this.closed = true; await this.removeWhere(() => true); await Promise.allSettled(this.flights.values()); }
}
