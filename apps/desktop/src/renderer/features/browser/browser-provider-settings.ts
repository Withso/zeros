import { useCallback, useSyncExternalStore } from "react";

export type BrowserProviderSettings =
  | { provider: "isolated" }
  | { provider: "shared-chrome"; endpoint: string }
  | { provider: "managed-cloud"; endpoint: string }
  | { provider: "system-computer-use" };

export type BrowserApprovalPolicy = "ask" | "auto-approve";

const STORAGE_KEY = "zeros.browserProvider";
const APPROVAL_STORAGE_KEY = "zeros.browserApprovalPolicy";
const DEFAULT_SETTINGS: BrowserProviderSettings = { provider: "isolated" };

export function parseBrowserProviderSettings(raw: string): BrowserProviderSettings {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.provider === "isolated") return DEFAULT_SETTINGS;
    if (parsed.provider === "shared-chrome" && typeof parsed.endpoint === "string") {
      return { provider: "shared-chrome", endpoint: parsed.endpoint };
    }
    if (parsed.provider === "managed-cloud" && typeof parsed.endpoint === "string") {
      return { provider: "managed-cloud", endpoint: parsed.endpoint };
    }
    if (parsed.provider === "system-computer-use") {
      return { provider: "system-computer-use" };
    }
  } catch {
    // Corrupt local UI state falls back to the isolated provider.
  }
  return DEFAULT_SETTINGS;
}

export function parseBrowserApprovalPolicy(raw: string): BrowserApprovalPolicy {
  return raw === "auto-approve" ? "auto-approve" : "ask";
}

export function browserProviderForSelection(value: string): BrowserProviderSettings {
  if (value === "shared-chrome") {
    return { provider: "shared-chrome", endpoint: "http://127.0.0.1:9222" };
  }
  if (value === "managed-cloud") {
    return { provider: "managed-cloud", endpoint: "https://browser.example.com/cdp" };
  }
  if (value === "system-computer-use") return { provider: "system-computer-use" };
  return DEFAULT_SETTINGS;
}

export function browserProviderWithEndpoint(
  current: BrowserProviderSettings,
  endpoint: string,
): BrowserProviderSettings {
  const value = endpoint.trim();
  if (current.provider === "shared-chrome") {
    return { provider: "shared-chrome", endpoint: value };
  }
  if (current.provider === "managed-cloud") {
    return { provider: "managed-cloud", endpoint: value };
  }
  throw new Error(`${current.provider} does not accept an endpoint.`);
}

export async function applyBrowserProviderSettings(
  next: BrowserProviderSettings,
  apply: (settings: BrowserProviderSettings) => Promise<unknown>,
  persist: (settings: BrowserProviderSettings) => void = setBrowserProviderSettings,
): Promise<BrowserProviderSettings> {
  await apply(next);
  persist(next);
  return next;
}

function read(): BrowserProviderSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return parseBrowserProviderSettings(raw);
  } catch {
    return DEFAULT_SETTINGS;
  }
}

let current = read();
const listeners = new Set<() => void>();

function readApprovalPolicy(): BrowserApprovalPolicy {
  try {
    return parseBrowserApprovalPolicy(
      localStorage.getItem(APPROVAL_STORAGE_KEY) ?? "ask",
    );
  } catch {
    return "ask";
  }
}

let currentApprovalPolicy = readApprovalPolicy();
const approvalListeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): BrowserProviderSettings {
  return current;
}

export function setBrowserProviderSettings(next: BrowserProviderSettings): void {
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Persistence is best-effort; the live host still receives the change.
  }
  for (const listener of listeners) listener();
}

export function useBrowserProviderSettings(): [
  BrowserProviderSettings,
  (next: BrowserProviderSettings) => void,
] {
  const value = useSyncExternalStore(subscribe, snapshot, snapshot);
  return [
    value,
    useCallback((next) => setBrowserProviderSettings(next), []),
  ];
}

export function setBrowserApprovalPolicy(next: BrowserApprovalPolicy): void {
  currentApprovalPolicy = next;
  try {
    localStorage.setItem(APPROVAL_STORAGE_KEY, next);
  } catch {
    // Persistence is best-effort; the live native broker still receives it.
  }
  for (const listener of approvalListeners) listener();
}

export function useBrowserApprovalPolicy(): [
  BrowserApprovalPolicy,
  (next: BrowserApprovalPolicy) => void,
] {
  const value = useSyncExternalStore(
    (listener) => {
      approvalListeners.add(listener);
      return () => approvalListeners.delete(listener);
    },
    () => currentApprovalPolicy,
    () => currentApprovalPolicy,
  );
  return [value, useCallback(setBrowserApprovalPolicy, [])];
}
