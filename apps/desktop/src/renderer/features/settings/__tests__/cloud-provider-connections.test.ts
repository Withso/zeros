import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudProviderCredential, readCloudOrganizationConnections } from "../cloud-provider-connection";
import type { connectCloudProviderSignIn } from "../cloud-provider-sign-in";
import type { ConnectionMethod } from "../connection-methods";
import type { CloudAgentConnectionHealth } from "@zeros/protocol";

type Connections = Awaited<ReturnType<typeof readCloudOrganizationConnections>>;
const f = vi.hoisted(() => ({
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "22222222-2222-4222-8222-222222222222",
  savedId: "33333333-3333-4333-8333-333333333333",
  createdId: "44444444-4444-4444-8444-444444444444",
  provider: "claude",
  active: true,
  current: true,
  epoch: 1,
  pending: false,
  scope: "",
  cursor: 0,
  hooks: new Map<string, unknown[]>(),
  snapshot: {
    data: undefined as Connections | undefined,
    refresh: vi.fn(async () => {}),
    error: null,
  },
  request: vi.fn<(path: string, schema: { parse(value: unknown): unknown }, options?: { body?: unknown }) => Promise<unknown>>(),
  signIn: vi.fn<typeof connectCloudProviderSignIn>(),
  success: vi.fn(),
  error: vi.fn(),
}));

// Preserve state and refs across explicit renders so real form handlers run
// against the same component instance. Child primitives are inspected as JSX.
vi.mock("react", async original => {
  function slot<T>(initialize: () => T): { slots: unknown[]; index: number; value: T } {
    const slots = f.hooks.get(f.scope) ?? [];
    f.hooks.set(f.scope, slots);
    const index = f.cursor++;
    if (!(index in slots)) slots[index] = initialize();
    return { slots, index, value: slots[index] as T };
  }
  return {
    ...await original<typeof import("react")>(),
    useState: <T>(initial: T | (() => T)) => {
      const state = slot(() => typeof initial === "function" ? (initial as () => T)() : initial);
      return [state.value, (next: T | ((previous: T) => T)) => {
        state.slots[state.index] = typeof next === "function"
          ? (next as (previous: T) => T)(state.slots[state.index] as T) : next;
      }];
    },
    useRef: <T>(initial: T) => slot(() => ({ current: initial })).value,
    useMemo: <T>(factory: () => T) => factory(),
    useEffect: vi.fn(),
  };
});
vi.mock("../../team/team-store", () => ({ useTeams: () => ({ me: { user: { id: f.userId } } }) }));
vi.mock("../internal-features", () => ({ useInternalFeatureActive: () => false }));
vi.mock("../settings-scope", async original => ({
  ...await original<typeof import("../settings-scope")>(),
  readScopedSettingsSelection: () => f.provider,
}));
vi.mock("../../../state/use-cached-read", () => ({ useCachedRead: () => f.snapshot }));
vi.mock("../use-cloud-credential-removal", () => ({ useCloudCredentialRemoval: () => {
  const epoch = f.epoch;
  return { pending: f.pending, busy: false, current: () => f.current && epoch === f.epoch,
    isPending: () => f.pending, start: vi.fn(), decide: vi.fn() };
} }));
vi.mock("../../agent/model-catalog", () => ({ modelsForAgent: () => [
  { value: "supported-first", label: "First model" },
  { value: "supported-second", label: "Second model" },
] }));
vi.mock("../../agent/workspace-agent-registry", () => ({ invalidateCloudOrganizationAgentRegistry: vi.fn() }));
vi.mock("../../agent/native-browser-availability", () => ({ NativeBrowserAvailability: () => null }));
vi.mock("../../../platform/cloud-workspaces", () => ({ cloudAccountRequest: f.request }));
vi.mock("../../../platform/app", () => ({ shellOpenUrl: vi.fn() }));
vi.mock("../cloud-provider-sign-in", () => ({ connectCloudProviderSignIn: f.signIn }));
vi.mock("../../../shared/ui/primitives/elements", () => ({ toast: { success: f.success, error: f.error } }));

import { Button } from "../../../shared/ui";
import { Checkbox } from "../../../shared/ui/primitives/checkbox";
import { CloudProviderConnections } from "../cloud-provider-connections";
import { ProviderConnectionDialog } from "../provider-connection-dialog";

type Element = ReactElement<{
  children?: ReactNode;
  disabled?: boolean;
  open?: boolean;
  connected?: boolean;
  connectedIdentity?: string;
  "aria-label"?: string;
  onClick?: () => void;
  onChange?: (event: { target: { value: string } }) => void;
  onMethodChange?: (method: ConnectionMethod) => void;
}>;
function elements(node: ReactNode): Element[] {
  const found: Element[] = [];
  Children.forEach(node, child => {
    if (!isValidElement(child)) return;
    const element = child as Element;
    found.push(element, ...elements(element.props.children));
  });
  return found;
}
function text(node: ReactNode): string {
  return Children.toArray(node).map(child => isValidElement(child)
    ? text((child as Element).props.children) : String(child)).join("");
}
function tree(): ReactNode {
  f.scope = "outer";
  f.cursor = 0;
  const outer = CloudProviderConnections({ organizationId: f.organizationId, surfaceActive: f.active, Tabs: () => null });
  const inner = elements(outer).find(element => typeof element.type === "function" && element.type.name === "CloudProviderConnection")!;
  f.scope = String(inner.key);
  f.cursor = 0;
  return (inner.type as (props: unknown) => ReactNode)(inner.props);
}
function action(label: string): Element {
  return elements(tree()).find(element => element.type === Button && element.props.children === label)!;
}
function dialog(): Element {
  return elements(tree()).find(element => element.type === ProviderConnectionDialog)!;
}
function submit(): Element {
  return elements(dialog().props.children).filter(element => element.type === Button).at(-1)!;
}
function input(label: string, value: string): void {
  elements(dialog().props.children).find(element => element.props["aria-label"] === label)!.props.onChange!({ target: { value } });
}
function credential(kind = "claude-api-key"): CloudProviderCredential {
  return { id: f.createdId, kind, displayName: "New account", revision: 6, revoked: false };
}
function expectSelection(): void {
  expect(f.request).toHaveBeenLastCalledWith(
    `/v1/organizations/${f.organizationId}/agent-connections/${f.provider}`,
    expect.anything(),
    expect.objectContaining({ method: "PUT", body: {
      expectedRevision: 12,
      credentialId: f.createdId,
      credentialRevision: 6,
      models: ["supported-first", "supported-second"],
      allModels: true,
      consent: "zeros-managed",
    } }),
  );
}
async function connected(): Promise<void> {
  await vi.waitFor(() => expect(f.success).toHaveBeenCalledOnce());
  expect(dialog().props.open).toBe(false);
  expect(f.error).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  f.hooks.clear();
  f.provider = "claude";
  f.active = true;
  f.current = true;
  f.epoch = 1;
  f.pending = false;
  f.snapshot.data = {
    credentials: [{ ...credential(), id: f.savedId, displayName: "Saved account", revision: 7 }],
    connections: [{ provider: "claude", revision: 12, credentialId: f.savedId,
      models: ["legacy-only"], allModels: false, connected: true }],
  };
  f.request.mockReset().mockImplementation(async (path, schema) => schema.parse(
    path.startsWith("/v1/cloud-agent-credentials/") ? { credential: credential() } : { revision: 13 },
  ));
  f.signIn.mockReset().mockResolvedValue(credential());
  f.snapshot.refresh.mockReset().mockResolvedValue();
});

function selectedHealth(status: CloudAgentConnectionHealth["status"] = "expired"): CloudAgentConnectionHealth {
  return { version: 1, status, observedAt: "2026-10-15T11:00:00Z", selectedCredentialRevision: 7,
    credentialRevision: status === "credential_unavailable" ? null : status === "credential_changed" ? 8 : 7,
    materialVersion: status === "credential_unavailable" ? null : 3,
    expiresAt: status === "expired" ? "2026-10-15T10:59:00Z" : status === "expiring" ? "2026-10-15T11:00:30Z" : null,
    refresh: status === "ready" ? "idle" : "reconnect_required" };
}
function selectedCodex(status: CloudAgentConnectionHealth["status"] = "expired"): void {
  f.provider = "codex";
  f.snapshot.data!.credentials[0]!.kind = "codex-chatgpt";
  Object.assign(f.snapshot.data!.connections[0]!, { provider: "codex", connected: false, health: selectedHealth(status) });
  f.signIn.mockResolvedValue(credential("codex-chatgpt"));
}

describe("selected cloud account health and reconnect", () => {
  it.each(["claude", "codex", "cursor"])("uses only %s's selected cloud identity for connected feedback", provider => {
    f.provider = provider;
    const saved = f.snapshot.data!.credentials[0]!;
    saved.kind = `${provider}-api-key`;
    saved.connectionMethod = "account";
    saved.displayName = "cloud@example.test";
    Object.assign(f.snapshot.data!.connections[0]!, { provider, health: selectedHealth("ready") });
    action("Configure").props.onClick!();
    expect(dialog().props.connected).toBe(true);
    expect(dialog().props.connectedIdentity).toBe("cloud@example.test");
    expect(text(dialog().props.children)).toContain("cloud@example.test is connected");

    dialog().props.onMethodChange!("apiKey");
    expect(dialog().props.connected).toBe(false);
    expect(dialog().props.connectedIdentity).toBeUndefined();
    expect(text(dialog().props.children)).not.toContain("cloud@example.test");
  });

  it("supplies the selected cloud API credential's name instead of any device account", () => {
    f.snapshot.data!.credentials[0]!.displayName = "Cloud automation";
    f.snapshot.data!.connections[0]!.health = selectedHealth("ready");
    action("Configure").props.onClick!();
    expect(dialog().props.connected).toBe(true);
    expect(dialog().props.connectedIdentity).toBe("Cloud automation");
  });
  it.each(["expired", "expiring"] as const)("shows %s instead of Connected and starts a fresh native ceremony", async status => {
    selectedCodex(status);
    // A stale legacy flag must not override the exact health observation.
    f.snapshot.data!.connections[0]!.connected = true;
    expect(text(tree())).not.toContain("Connected");
    expect(text(tree())).toContain(status === "expired" ? "Connection expired" : "Connection expires soon");
    expect(action("Disconnect")).toBeDefined();
    action("Reconnect").props.onClick!();
    expect(dialog().props.open).toBe(true);
    expect(elements(dialog().props.children).some(element => element.props["aria-label"] === "Account name")).toBe(true);
    expect((dialog().props as { connected?: boolean }).connected).toBe(false);
    submit().props.onClick!();
    await connected();
    expect(f.signIn).toHaveBeenCalledOnce();
    expectSelection();
  });

  it("does not treat a new unselected import as health for the old selection", () => {
    selectedCodex();
    f.snapshot.data!.credentials.push(credential("codex-chatgpt"));
    expect(text(tree())).toContain("Connection expired");
    expect(text(tree())).not.toContain("Connected");
    expect(action("Reconnect")).toBeDefined();
  });

  it("keeps a legacy selection's health explicitly unavailable", () => {
    expect(text(tree())).toContain("Status unavailable");
    expect(text(tree())).not.toContain("Connected");
    expect(action("Configure")).toBeDefined();
  });

  it("shows Connected only for ready health at the exact selected source revision", () => {
    selectedCodex("ready");
    f.snapshot.data!.connections[0]!.connected = true;
    expect(text(tree())).toContain("Connected");
    f.snapshot.data!.credentials[0]!.revision += 1;
    expect(text(tree())).not.toContain("Connected");
    expect(text(tree())).toContain("Account changed");
  });

  it.each([
    ["consent_required", "Permission required", "Configure"],
    ["credential_changed", "Account changed", "Configure"],
    ["credential_unavailable", "Account unavailable", "Reconnect"],
  ] as const)("keeps %s as a closed observation with an explicit action", (status, label, actionLabel) => {
    selectedCodex(status);
    expect(text(tree())).toContain(label);
    expect(text(tree())).not.toContain("Connected");
    expect(action(actionLabel)).toBeDefined();
    expect(action("Disconnect")).toBeDefined();
    expect(f.request).not.toHaveBeenCalled();
    expect(f.signIn).not.toHaveBeenCalled();
  });

  it("does not turn an in-progress refresh observation into readiness or a client refresh", () => {
    selectedCodex();
    Object.assign(f.snapshot.data!.connections[0]!, { health: { ...selectedHealth(), refresh: "in_progress" } });
    expect(text(tree())).toContain("Connection expired");
    expect(text(tree())).not.toContain("Connected");
    expect(action("Reconnect")).toBeDefined();
    expect(f.request).not.toHaveBeenCalled();
    expect(f.signIn).not.toHaveBeenCalled();
  });

  it.each(["agent_credential_conflict", "agent_connection_conflict"])("retains the new import after %s and retries only on an explicit click", async code => {
    selectedCodex();
    f.request.mockRejectedValueOnce(Object.assign(new Error("untrusted conflict detail"), { code, status: 409 }));
    f.snapshot.refresh.mockImplementationOnce(async () => {
      f.snapshot.data!.connections[0]!.revision = 14;
      f.snapshot.data!.credentials.push({ ...credential("codex-chatgpt"), revision: 8 });
    });
    // Add account also must preserve a completed import on selection failure.
    action("Add account").props.onClick!();
    submit().props.onClick!();
    await vi.waitFor(() => expect(f.snapshot.refresh).toHaveBeenCalledOnce());
    expect(f.error).toHaveBeenCalledExactlyOnceWith("Your saved accounts changed. Review the refreshed list, then connect again.");
    expect(f.request).toHaveBeenCalledOnce();
    expect(f.signIn).toHaveBeenCalledOnce();
    expect(dialog().props.open).toBe(true);
    expect(text(dialog().props.children)).toContain("New account");
    expect(submit().props.disabled).toBe(false);
    f.error.mockClear();
    submit().props.onClick!();
    await connected();
    expect(f.signIn).toHaveBeenCalledOnce();
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(f.request.mock.calls[1]?.[2]).toEqual(expect.objectContaining({ body: expect.objectContaining({
      expectedRevision: 14, credentialId: f.createdId, credentialRevision: 8,
    }) }));
  });

  it.each(["owner-retired", "owner-a-b-a", "hidden"])("does not select or publish an import after %s", async state => {
    selectedCodex();
    let resolve!: (value: CloudProviderCredential) => void;
    f.signIn.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    action("Add account").props.onClick!();
    submit().props.onClick!();
    expect(f.signIn).toHaveBeenCalledOnce();
    if (state === "owner-retired") f.current = false;
    if (state === "owner-a-b-a") f.epoch += 2;
    if (state === "hidden") f.active = false;
    tree();
    resolve(credential("codex-chatgpt"));
    await vi.waitFor(() => expect(f.signIn.mock.settledResults[0]?.type).toBe("fulfilled"));
    expect(f.request).not.toHaveBeenCalled();
    expect(f.snapshot.refresh).not.toHaveBeenCalled();
    expect(f.success).not.toHaveBeenCalled();
    expect(f.error).not.toHaveBeenCalled();
  });

  it("does not publish a late native device code after owner A to B to A", async () => {
    selectedCodex();
    let resolve!: (value: CloudProviderCredential) => void;
    f.signIn.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    action("Add account").props.onClick!();
    submit().props.onClick!();
    f.epoch += 2;
    tree();
    f.signIn.mock.calls[0]![2]({ attemptId: f.createdId, organizationId: f.organizationId, provider: "codex", state: "connecting",
      deviceCode: { verificationUrl: "https://auth.openai.com/codex/device", userCode: "RETIRED-CODE" } });
    expect(text(dialog().props.children)).not.toContain("RETIRED-CODE");
    resolve(credential("codex-chatgpt"));
    await vi.waitFor(() => expect(f.signIn.mock.settledResults[0]?.type).toBe("fulfilled"));
    expect(f.request).not.toHaveBeenCalled();
  });

  it("does not recreate or select an imported account absent from refreshed metadata", async () => {
    selectedCodex();
    f.request.mockRejectedValueOnce(Object.assign(new Error("agent_connection_conflict"), { code: "agent_connection_conflict" }));
    action("Add account").props.onClick!();
    submit().props.onClick!();
    await vi.waitFor(() => expect(submit().props.disabled).toBe(false));
    expect(text(dialog().props.children)).toContain("New account");
    f.error.mockClear();
    submit().props.onClick!();
    await vi.waitFor(() => expect(f.error).toHaveBeenCalledOnce());
    expect(f.error).toHaveBeenCalledWith("This saved account is unavailable. Refresh accounts and choose again.");
    expect(f.signIn).toHaveBeenCalledOnce();
    expect(f.request).toHaveBeenCalledOnce();
    expect(f.success).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"])("does not publish a late selection %s after the owner changes", async outcome => {
    let resolve!: (value: unknown) => void, reject!: (error: unknown) => void;
    f.request.mockImplementationOnce(() => new Promise((done, fail) => { resolve = done; reject = fail; }));
    action("Configure").props.onClick!();
    submit().props.onClick!();
    f.epoch += 2;
    tree();
    if (outcome === "resolve") resolve({ revision: 13 });
    else reject(Object.assign(new Error("agent_credential_conflict"), { code: "agent_credential_conflict" }));
    await vi.waitFor(() => expect(submit().props.children).toBe("Connect"));
    expect(f.request).toHaveBeenCalledOnce();
    expect(f.success).not.toHaveBeenCalled();
    expect(f.error).not.toHaveBeenCalled();
    expect(f.snapshot.refresh).not.toHaveBeenCalled();
  });
});

describe("one-step organization provider connection", () => {
  it("shows the approved storage copy and Connect without model controls", () => {
    action("Configure").props.onClick!();
    const form = dialog();
    expect(form.props.open).toBe(true);
    expect(elements(form.props.children).filter(element => element.type === "p").map(element => text(element.props.children)))
      .toContain("Connecting stores this account encrypted in the cloud for your sessions on Zeros-managed computers in this organization, until you disconnect.");
    expect(text(form.props.children)).not.toMatch(/Allow all models|Allowed models|Includes future models/);
    expect(elements(form.props.children).some(element => element.type === Checkbox)).toBe(false);
    expect(submit().props.children).toBe("Connect");
  });

  it.each([false, undefined])("reconnects a legacy allModels=%s account with every supported model", async allModels => {
    f.snapshot.data!.connections[0]!.allModels = allModels;
    action("Configure").props.onClick!();
    expect(submit().props.disabled).toBe(false);
    submit().props.onClick!();
    await connected();
    expect(f.request).toHaveBeenCalledExactlyOnceWith(
      `/v1/organizations/${f.organizationId}/agent-connections/claude`, expect.anything(),
      expect.objectContaining({ method: "PUT", body: {
        expectedRevision: 12, credentialId: f.savedId, credentialRevision: 7,
        models: ["supported-first", "supported-second"], allModels: true, consent: "zeros-managed",
      } }),
    );
    expect(f.signIn).not.toHaveBeenCalled();
  });

  it("saves and connects a new API credential without a model-selection step", async () => {
    action("Add account").props.onClick!();
    dialog().props.onMethodChange!("apiKey");
    expect(submit().props.disabled).toBe(true);
    input("Account name", " New API account ");
    input("Cloud API key", " synthetic-test-token ");
    submit().props.onClick!();
    await connected();
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(f.request.mock.calls[0]?.[2]).toEqual(expect.objectContaining({ method: "PUT", body: expect.objectContaining({
      displayName: "New API account", organizationId: f.organizationId, expectedRevision: 0,
      material: { kind: "claude-api-key", apiKey: "synthetic-test-token" },
    }) }));
    expectSelection();
  });

  it.each(["codex", "cursor"] as const)("connects a new %s sign-in with all models and the exact organization", async provider => {
    f.provider = provider;
    f.snapshot.data!.connections = [{ provider, revision: 12, credentialId: null, models: [], connected: false }];
    f.signIn.mockResolvedValue(credential(provider === "codex" ? "codex-chatgpt" : "cursor-account"));
    action("Connect").props.onClick!();
    submit().props.onClick!();
    await connected();
    expect(f.signIn).toHaveBeenCalledExactlyOnceWith({ organizationId: f.organizationId, provider,
      displayName: provider === "codex" ? "Codex account" : "Cursor account" }, expect.any(AbortSignal), expect.any(Function));
    expect(f.request).toHaveBeenCalledOnce();
    expectSelection();
  });

  it("shows Connecting… and keeps a held selection single-flight", async () => {
    let release!: (value: unknown) => void;
    f.request.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    action("Configure").props.onClick!();
    const connect = submit().props.onClick!;
    connect();
    expect(submit().props.children).toBe("Connecting…");
    expect(submit().props.disabled).toBe(true);
    connect();
    expect(f.request).toHaveBeenCalledOnce();
    release({ revision: 13 });
    await connected();
  });

  it("explains a busy credential update and keeps the connection ready to retry", async () => {
    f.request.mockRejectedValueOnce(Object.assign(new Error("cloud_agent_credential_busy"), {
      code: "cloud_agent_credential_busy", status: 503,
    }));
    action("Configure").props.onClick!();
    submit().props.onClick!();
    await vi.waitFor(() => expect(f.error).toHaveBeenCalledOnce());
    expect(f.error).toHaveBeenCalledWith("Your cloud connection is being updated. Try again in a moment.");
    expect(dialog().props.open).toBe(true);
    expect(submit().props.disabled).toBe(false);
    expect(f.success).not.toHaveBeenCalled();
    f.error.mockClear();
    submit().props.onClick!();
    await connected();
  });

  it.each(["hidden", "removal-pending", "retired-owner"])("keeps a %s dialog from submitting", async state => {
    action("Configure").props.onClick!();
    if (state === "hidden") f.active = false;
    if (state === "removal-pending") f.pending = true;
    if (state === "retired-owner") f.current = false;
    submit().props.onClick!();
    await Promise.resolve();
    expect(f.request).not.toHaveBeenCalled();
    expect(f.signIn).not.toHaveBeenCalled();
  });
});
