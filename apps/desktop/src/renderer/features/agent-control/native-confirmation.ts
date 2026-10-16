import type { AgentControlConfirmationRequest } from "@zeros/protocol/agent-control";

import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "../../platform/bridge/agent-events";
import {
  browserConfirmationToPermissionRequest,
  respondToBrowserConfirmation,
  type BrowserConfirmationEvent,
} from "../browser/browser-confirmation-store";
import {
  agentControlConfirmationToPermissionRequest,
  respondToAgentControlConfirmation,
} from "./agent-control-confirmation-store";

/** An approval Electron main asks a chat for: a Browser action, or control
 * of an app or simulator. */
export type NativeConfirmation =
  | { source: "browser"; request: BrowserConfirmationEvent }
  | { source: "agent-control"; request: AgentControlConfirmationRequest };

/** The chat's composer shows one approval at a time, oldest first. */
export function nextNativeConfirmation(
  browser: BrowserConfirmationEvent | null,
  control: AgentControlConfirmationRequest | null,
): NativeConfirmation | null {
  if (browser && (!control || browser.createdAt <= control.createdAt)) {
    return { source: "browser", request: browser };
  }
  return control ? { source: "agent-control", request: control } : null;
}

export function nativeConfirmationToPermissionRequest(
  confirmation: NativeConfirmation,
): RequestPermissionRequest {
  return confirmation.source === "browser"
    ? browserConfirmationToPermissionRequest(confirmation.request)
    : agentControlConfirmationToPermissionRequest(confirmation.request);
}

export function respondToNativeConfirmation(
  confirmation: NativeConfirmation,
  response: RequestPermissionResponse,
): Promise<void> {
  return confirmation.source === "browser"
    ? respondToBrowserConfirmation(confirmation.request, response)
    : respondToAgentControlConfirmation(confirmation.request, response);
}

export function nativeConfirmationFailureText(
  confirmation: NativeConfirmation,
): string {
  return confirmation.source === "browser"
    ? "Couldn't respond to the browser permission request."
    : "Couldn't respond to the approval request.";
}
