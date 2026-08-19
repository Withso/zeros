interface ProviderConnectionAgent {
  readonly installed?: boolean;
  readonly authenticated?: boolean;
  readonly runtimeUnavailableReason?: string;
  readonly authenticationUnavailableReason?: string;
}

export interface ProviderConnectionStatus {
  readonly label: string;
  readonly tone: "success" | "warning" | "error";
  readonly detail?: string;
}

export function providerConnectionStatus(
  agent: ProviderConnectionAgent,
): ProviderConnectionStatus {
  if (agent.authenticated === true) {
    return { label: "Connected", tone: "success" };
  }
  if (agent.runtimeUnavailableReason) {
    return {
      label: "Runtime missing",
      tone: "error",
      detail: agent.runtimeUnavailableReason,
    };
  }
  if (agent.authenticationUnavailableReason) {
    return {
      label: "Authentication check unavailable",
      tone: "warning",
      detail: agent.authenticationUnavailableReason,
    };
  }
  return agent.installed
    ? { label: "CLI not authenticated", tone: "error" }
    : { label: "CLI not found", tone: "error" };
}
