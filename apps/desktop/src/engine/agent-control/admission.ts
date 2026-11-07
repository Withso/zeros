import {
  agentControlUnavailableReason,
  type AgentControlFeature,
} from "@zeros/protocol/agent-control-rollout";
import {
  BROWSER_TOOL_NAMESPACE,
  isAgentControlFamily,
  type AgentControlFamily,
  type BrowserJsonValue,
  type BrowserRoute,
  type BrowserToolName,
  type BrowserToolResult,
} from "@zeros/protocol/browser-tools";
import {
  COMPUTER_TOOL_NAMESPACE,
  type ComputerToolInvokeRequest,
  type ComputerToolResult,
  type ComputerUseOwner,
  type ComputerUseRoute,
} from "@zeros/protocol/computer-use-tools";
import {
  DEVICE_TOOL_NAMESPACE,
  type DeviceToolInvokeRequest,
  type DeviceToolResult,
  type DeviceToolRoute,
  type DeviceUseOwner,
} from "@zeros/protocol/device-tools";

import type {
  AgentSessionToolFactory,
  AgentSessionTools,
} from "../agents/session-tools";
import {
  DesignAgentMcpServer,
  type DesignMcpToolHandler,
} from "../design/design-agent-mcp";
import { getWorkspaceById, type Workspace } from "../git";
import { agentControlFeatureAvailable } from "./availability";
import type { HostedControlToolPolicy } from "./hosted-control-tools";
import {
  ZerosBrowserTools,
  zerosBrowserToolPolicy,
} from "./zeros-browser-tools";
import {
  ZerosComputerTools,
  zerosComputerToolPolicy,
} from "./zeros-computer-tools";
import { ZerosDeviceTools, zerosDeviceToolPolicy } from "./zeros-device-tools";

export const ZEROS_BROWSER_TOOLS_ENV = "ZEROS_BROWSER_TOOLS_CAPABILITY" as const;
export const ZEROS_COMPUTER_TOOLS_ENV =
  "ZEROS_COMPUTER_TOOLS_CAPABILITY" as const;
export const ZEROS_DEVICE_TOOLS_ENV = "ZEROS_DEVICE_TOOLS_CAPABILITY" as const;
/** Where `zeros computer` / `zeros browser` reach the same server's `/call`.
 * The bearer stays in the capability variable above. */
export const ZEROS_COMPUTER_TOOLS_URL_ENV = "ZEROS_COMPUTER_TOOLS_URL" as const;
export const ZEROS_BROWSER_TOOLS_URL_ENV = "ZEROS_BROWSER_TOOLS_URL" as const;

/** Names an engine must drop from its own environment at start, so a Zeros
 * launched from a chat's shell cannot use that chat's browser or computer. */
export const AGENT_CONTROL_RESERVED_ENV: readonly string[] = [
  ZEROS_BROWSER_TOOLS_ENV,
  ZEROS_COMPUTER_TOOLS_ENV,
  ZEROS_DEVICE_TOOLS_ENV,
  ZEROS_COMPUTER_TOOLS_URL_ENV,
  ZEROS_BROWSER_TOOLS_URL_ENV,
];

export function stripInheritedAgentControlEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): void {
  for (const name of AGENT_CONTROL_RESERVED_ENV) delete env[name];
}

/** Before each turn: agents use their shell first, so name the commands that
 * keep Zeros' control bar, Stop and blocked apps. */
export function agentControlBrief(surfaces: { computer: boolean; browser: boolean }): string {
  const lines: string[] = [];
  if (surfaces.computer) {
    // The main verbs, so agents act without spending a turn on --help.
    lines.push(
      "Computer use on this Mac, from the shell: `zeros computer open --app NAME [URL] [--wait-title TEXT]` opens without taking focus; `zeros computer shot --app NAME` saves a screenshot (read the PNG path it prints) and lists element tokens; `click --app NAME --element TOKEN`, `type --app NAME TEXT`, `key --app NAME KEY [--mods cmd]`. One `type` (`type --app Calculator 12*34=`) beats clicking each on-screen button. Chain steps with `&&` or `batch -`; `--help` lists the rest. Use plain shell for files, git and CLIs. A sandboxed shell without network access cannot reach Zeros, so there use the zeros_computer tools from the start.",
    );
  }
  if (surfaces.browser) {
    lines.push(
      "Zeros browser, from the shell: `zeros browser open URL` (prints the page), `read --find TEXT`, `click REF`, `type REF TEXT`; `--help` lists the rest. A sandboxed shell without network access cannot reach Zeros, so there use the zeros_browser tools from the start.",
    );
  }
  return lines.join("\n");
}
// One browser action can wait for a website approval and then a download.
const BROWSER_TOOL_TIMEOUT_SEC = 600;
// One computer action can wait for another chat and then for an approval.
const COMPUTER_TOOL_TIMEOUT_SEC = 660;
// One simulator action can wait for an approval and then a boot.
const DEVICE_TOOL_TIMEOUT_SEC = 660;
// Process-wide ceiling on admitted executions, matching Design admissions.
const MAX_ADMITTED_EXECUTIONS = 16;

/** The rollout decides before Settings do, so a feature that closes while an
 * agent runs refuses that agent's next call. */
function rolloutPolicy(
  feature: AgentControlFeature,
  settings: () => HostedControlToolPolicy,
): HostedControlToolPolicy {
  return agentControlFeatureAvailable(feature)
    ? settings()
    : { ok: false, reason: agentControlUnavailableReason(feature) };
}

/** The Electron browser host as the engine reaches it. */
export interface AgentControlBrowserHost {
  /** The desktop app handed this engine a browser service capability. */
  configured(): boolean;
  route(
    agentFamily: string,
    workspacePath: string,
    repoRoot: string,
  ): BrowserRoute;
  acquire(owner: {
    workspaceId: string;
    conversationId: string;
    workspaceRoot: string;
  }): Promise<{ browserSessionId: string } | null>;
  invoke(request: {
    browserSessionId: string;
    tool: BrowserToolName;
    arguments: BrowserJsonValue;
    agent: AgentControlFamily;
    signal?: AbortSignal;
  }): Promise<BrowserToolResult>;
  stop(browserSessionId: string): Promise<boolean>;
}

/** Electron main's computer use as the engine reaches it. */
export interface AgentControlComputerHost {
  /** The desktop app handed this engine an agent control capability on a
   * Mac. */
  configured(): boolean;
  route(
    agentFamily: string,
    workspacePath: string,
    repoRoot: string,
  ): ComputerUseRoute;
  invoke(
    request: Omit<ComputerToolInvokeRequest, "version">,
    signal: AbortSignal,
  ): Promise<ComputerToolResult>;
  release(
    owner: ComputerUseOwner,
    reason: "turn-end" | "stop",
  ): Promise<boolean>;
}

/** Electron main's simulators as the engine reaches them. */
export interface AgentControlDeviceHost {
  /** The desktop app handed this engine an agent control capability on a
   * Mac. */
  configured(): boolean;
  route(
    agentFamily: string,
    workspacePath: string,
    repoRoot: string,
  ): DeviceToolRoute;
  invoke(
    request: Omit<DeviceToolInvokeRequest, "version">,
    signal: AbortSignal,
  ): Promise<DeviceToolResult>;
  release(owner: DeviceUseOwner, reason: "turn-end" | "stop"): Promise<boolean>;
}

interface ControlToolSet extends DesignMcpToolHandler {
  readonly token: string;
  beginPrompt(): void;
  endPrompt(): Promise<void>;
  cancel(): void;
  dispose(): void;
}

interface AdmittedToolSet {
  tools: ControlToolSet;
  server: DesignAgentMcpServer;
  credentialEnv: string;
  urlEnv?: string;
}

/** Admit Zeros-owned control tools (browser, computer use and simulators) for
 * Local workspace conversations. Cloud placements and the cloud worker get
 * none: these tools drive surfaces on the user's Mac. */
export class AgentControlToolAdmissions {
  private count = 0;

  constructor(
    private readonly options: {
      cloudWorker?: boolean;
      resolveWorkspace?: (id: string) => Workspace | null;
      browser: AgentControlBrowserHost;
      computer?: AgentControlComputerHost;
      device?: AgentControlDeviceHost;
      /** The directory holding the shared `zeros` launcher, once it exists. */
      binDir?: () => string | null;
    },
  ) {}

  readonly admit: AgentSessionToolFactory = async (
    input,
  ): Promise<AgentSessionTools | null> => {
    input.signal.throwIfAborted();
    const family = input.agentId;
    const conversationId = input.conversationId;
    if (
      this.options.cloudWorker ||
      !isAgentControlFamily(family) ||
      !input.workspaceId ||
      !conversationId
    ) {
      return null;
    }
    const resolveWorkspace = this.options.resolveWorkspace ?? getWorkspaceById;
    const workspace = resolveWorkspace(input.workspaceId);
    if (
      !workspace ||
      workspace.archivedAt != null ||
      workspace.placement === "cloud" ||
      this.count >= MAX_ADMITTED_EXECUTIONS
    ) {
      return null;
    }
    // A closed Zeros browser leaves Codex no fallback: before it, Codex had
    // only its built-in browser.
    const browser =
      agentControlFeatureAvailable("zerosBrowser") &&
      this.options.browser.configured()
        ? this.options.browser
        : null;
    const computer = this.computerHostFor(family, workspace);
    const device = this.deviceHostFor(family, workspace);
    if (!browser && !computer && !device) return null;

    this.count += 1;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        this.count -= 1;
      }
    };
    const assertOwner = (what: string) => {
      const current = resolveWorkspace(workspace.id);
      if (
        !current ||
        current.archivedAt != null ||
        current.path !== workspace.path ||
        current.repoRoot !== workspace.repoRoot ||
        current.placement !== workspace.placement ||
        current.organizationId !== workspace.organizationId
      ) {
        throw new Error(
          `The workspace that owns this ${what} changed; reopen the conversation.`,
        );
      }
    };
    const owner: ComputerUseOwner = {
      workspaceId: workspace.id as ComputerUseOwner["workspaceId"],
      conversationId: conversationId as ComputerUseOwner["conversationId"],
    };

    const candidates: Array<{
      tools: ControlToolSet;
      name: string;
      credentialEnv: string;
      urlEnv?: string;
      toolTimeoutSec: number;
    }> = [];
    if (browser) {
      candidates.push({
        tools: new ZerosBrowserTools({
          policy: () =>
            rolloutPolicy("zerosBrowser", () =>
              zerosBrowserToolPolicy(
                browser.route(family, workspace.path, workspace.repoRoot),
              ),
            ),
          assertOwner: () => assertOwner("browser"),
          acquire: () =>
            browser.acquire({
              workspaceId: workspace.id,
              conversationId,
              workspaceRoot: workspace.path,
            }),
          invoke: (request) => browser.invoke({ ...request, agent: family }),
          stop: (browserSessionId) => browser.stop(browserSessionId),
        }),
        name: BROWSER_TOOL_NAMESPACE,
        credentialEnv: ZEROS_BROWSER_TOOLS_ENV,
        urlEnv: ZEROS_BROWSER_TOOLS_URL_ENV,
        toolTimeoutSec: BROWSER_TOOL_TIMEOUT_SEC,
      });
    }
    if (computer) {
      candidates.push({
        tools: new ZerosComputerTools({
          policy: () =>
            rolloutPolicy("computerUse", () =>
              zerosComputerToolPolicy(
                computer.route(family, workspace.path, workspace.repoRoot),
              ),
            ),
          assertOwner: () => assertOwner("computer use"),
          invoke: ({ signal, ...request }) =>
            computer.invoke({ ...request, owner, agent: family }, signal),
          release: (reason) => computer.release(owner, reason),
        }),
        name: COMPUTER_TOOL_NAMESPACE,
        credentialEnv: ZEROS_COMPUTER_TOOLS_ENV,
        urlEnv: ZEROS_COMPUTER_TOOLS_URL_ENV,
        toolTimeoutSec: COMPUTER_TOOL_TIMEOUT_SEC,
      });
    }
    if (device) {
      candidates.push({
        tools: new ZerosDeviceTools({
          policy: () =>
            rolloutPolicy("simulators", () =>
              zerosDeviceToolPolicy(
                device.route(family, workspace.path, workspace.repoRoot),
              ),
            ),
          assertOwner: () => assertOwner("simulator use"),
          invoke: ({ signal, ...request }) =>
            device.invoke({ ...request, owner, agent: family }, signal),
          release: (reason) => device.release(owner, reason),
        }),
        name: DEVICE_TOOL_NAMESPACE,
        credentialEnv: ZEROS_DEVICE_TOOLS_ENV,
        toolTimeoutSec: DEVICE_TOOL_TIMEOUT_SEC,
      });
    }

    const admitted: AdmittedToolSet[] = [];
    const retire = async () => {
      for (const set of admitted) set.tools.dispose();
      await Promise.allSettled(admitted.map((set) => set.server.stop()));
    };
    try {
      for (const candidate of candidates) {
        const server = new DesignAgentMcpServer({
          handler: candidate.tools,
          token: candidate.tools.token,
          name: candidate.name,
          credentialEnv: candidate.credentialEnv,
          toolTimeoutSec: candidate.toolTimeoutSec,
        });
        try {
          await server.start();
        } catch {
          // Control tools are optional; the agent still starts without them.
          candidate.tools.dispose();
          await server.stop();
          continue;
        }
        admitted.push({
          tools: candidate.tools,
          server,
          credentialEnv: candidate.credentialEnv,
          ...(candidate.urlEnv ? { urlEnv: candidate.urlEnv } : {}),
        });
      }
      input.signal.throwIfAborted();
    } catch (error) {
      await retire();
      release();
      throw error;
    }
    if (admitted.length === 0) {
      release();
      return null;
    }
    let disposal: Promise<void> | undefined;
    const binDir = this.options.binDir?.() ?? null;
    const brief = binDir && agentControlBrief({
      computer: admitted.some((set) => set.urlEnv === ZEROS_COMPUTER_TOOLS_URL_ENV),
      browser: admitted.some((set) => set.urlEnv === ZEROS_BROWSER_TOOLS_URL_ENV),
    });
    return {
      env: Object.fromEntries(
        admitted.flatMap((set) => [
          [set.credentialEnv, `Bearer ${set.tools.token}`],
          ...(set.urlEnv ? [[set.urlEnv, set.server.callUrl]] : []),
        ]),
      ),
      // The host makes every allow/deny decision itself (blocked apps,
      // consequential browser actions, simulator approvals), so a provider's
      // own per-call card (Codex asks for each MCP call) would be a second,
      // mid-turn prompt.
      mcpServers: admitted.map((set) => ({ ...set.server.registration, defaultToolsApproval: "approve" as const })),
      ...(binDir ? { pathPrepend: [binDir] } : {}),
      ...(brief ? { preparePrompt: () => brief } : {}),
      beginPrompt: () => admitted.forEach((set) => set.tools.beginPrompt()),
      endPrompt: async () => {
        await Promise.allSettled(admitted.map((set) => set.tools.endPrompt()));
      },
      cancel: () => admitted.forEach((set) => set.tools.cancel()),
      listedMcpServers: () =>
        admitted.filter((set) => set.server.listedTools).map((set) => set.server.name),
      revoke: () => admitted.forEach((set) => set.tools.dispose()),
      dispose: () => (disposal ??= retire().finally(release)),
    };
  };

  /** Computer tools are listed once, when the provider boots, so only an
   * agent whose route is Zeros' own computer use gets them. A Settings change
   * reaches a running agent by resuming it. */
  private computerHostFor(
    family: AgentControlFamily,
    workspace: Workspace,
  ): AgentControlComputerHost | null {
    const computer = this.options.computer;
    if (!agentControlFeatureAvailable("computerUse") || !computer?.configured())
      return null;
    try {
      return computer.route(family, workspace.path, workspace.repoRoot) ===
        "zeros"
        ? computer
        : null;
    } catch {
      return null;
    }
  }

  /** The same boot-time rule for the simulator tools. */
  private deviceHostFor(
    family: AgentControlFamily,
    workspace: Workspace,
  ): AgentControlDeviceHost | null {
    const device = this.options.device;
    if (!agentControlFeatureAvailable("simulators") || !device?.configured())
      return null;
    try {
      return device.route(family, workspace.path, workspace.repoRoot) === "zeros"
        ? device
        : null;
    } catch {
      return null;
    }
  }
}
