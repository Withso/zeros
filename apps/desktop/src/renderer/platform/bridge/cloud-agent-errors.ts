import type { CloudAgentAdmissionCode } from "@zeros/protocol/cloud-agent-execution";

export class CloudAgentAdmissionError extends Error {
  constructor(readonly code: CloudAgentAdmissionCode) {
    super(code);
    this.name = "CloudAgentAdmissionError";
  }
}
