import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from "react";
import { Button, Input } from "../../shared/ui";
import { toast } from "../../shared/ui/primitives/elements";
import { useTeams } from "../team/team-store";
import { modelsForAgent } from "../agent/model-catalog";
import { AgentIcon } from "../agent/agent-icon";
import { NativeBrowserAvailability } from "../agent/native-browser-availability";
import { invalidateCloudOrganizationAgentRegistry } from "../agent/workspace-agent-registry";
import { useCachedRead } from "../../state/use-cached-read";
import { ProviderConnectionDialog } from "./provider-connection-dialog";
import { CloudCredentialRemovalDialog } from "./cloud-credential-removal-dialog";
import { useCloudCredentialRemoval } from "./use-cloud-credential-removal";
import type { ConnectionMethod } from "./connection-methods";
import {
  readScopedSettingsSelection,
  writeScopedSettingsSelection,
  settingsOwnerKey,
} from "./settings-scope";
import { subscribeProviderSettingsTab } from "./settings-navigation";
import { useInternalFeatureActive } from "./internal-features";
import { ReleaseCanaryControl } from "./release-canary-control";
import { connectCloudProviderSignIn } from "./cloud-provider-sign-in";
import { shellOpenUrl } from "../../platform/app";
import type { CloudProviderAuthStatus } from "@zeros/protocol/provider-auth";
import {
  cloudOrganizationConnectionsCache,
  readCloudOrganizationConnections,
  cloudOrganizationCredentialRemovalTarget,
  cloudProviderDisconnectTarget,
  saveCloudProviderCredential,
  selectCloudOrganizationCredential,
  type CloudProviderCredential,
} from "./cloud-provider-connection";

// Authentication is available before any VM exists. Each workspace's registry
// independently checks whether its runtime supports the connected provider.
const PROVIDERS = [
  { id: "claude", name: "Claude Code" },
  { id: "codex", name: "Codex" },
  { id: "cursor", name: "Cursor" },
];
type Provider = { id: string; name: string; beta?: boolean };
type Tabs = ComponentType<{
  providers: Provider[];
  activeId: string;
  onSelect: (id: string) => void;
}>;

export function CloudProviderConnections({
  organizationId,
  surfaceActive,
  Tabs,
}: {
  organizationId: string;
  surfaceActive: boolean;
  Tabs: Tabs;
}) {
  const { me } = useTeams();
  const canManageReleaseChecks = useInternalFeatureActive("releaseCanaries");
  const owner = settingsOwnerKey(me?.user.id ?? "pending", organizationId);
  const [agentId, setAgentId] = useState(() =>
    readScopedSettingsSelection(owner, "provider", "claude"),
  );
  const agent = PROVIDERS.find((row) => row.id === agentId) ?? PROVIDERS[0]!;
  useEffect(() => subscribeProviderSettingsTab(setAgentId, owner), [owner]);
  return (
    <div className="flex flex-col gap-8">
      <Tabs
        providers={PROVIDERS}
        activeId={agent.id}
        onSelect={(id) => {
          setAgentId(id);
          writeScopedSettingsSelection(owner, "provider", id);
        }}
      />
      {me && (
        <CloudProviderConnection
          key={`${owner}:${agent.id}`}
          organizationId={organizationId}
          userId={me.user.id}
          agent={agent}
          surfaceActive={surfaceActive}
          canManageReleaseChecks={canManageReleaseChecks}
        />
      )}
    </div>
  );
}

function CloudProviderConnection({
  organizationId,
  userId,
  agent,
  surfaceActive,
  canManageReleaseChecks,
}: {
  organizationId: string;
  userId: string;
  agent: Provider;
  surfaceActive: boolean;
  canManageReleaseChecks: boolean;
}) {
  const key = settingsOwnerKey(userId, organizationId);
  const snapshot = useCachedRead(
    cloudOrganizationConnectionsCache,
    key,
    () => readCloudOrganizationConnections(organizationId),
    { enabled: surfaceActive, maxAgeMs: 30_000 },
  );
  const matching = (snapshot.data?.credentials ?? []).filter((row) =>
    row.kind.startsWith(`${agent.id}-`),
  );
  const connection = snapshot.data?.connections.find(
    (row) => row.provider === agent.id,
  );
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<CloudProviderCredential | null>(
    null,
  );
  const [method, setMethod] = useState<ConnectionMethod>("account");
  const [displayName, setDisplayName] = useState("");
  const [token, setToken] = useState("");
  const [connectionBusy, setBusy] = useState(false);
  const inFlight = useRef(false),
    mounted = useRef(true);
  const signIn = useRef<AbortController | null>(null);
  const [authStatus, setAuthStatus] = useState<CloudProviderAuthStatus | null>(
    null,
  );
  const models = useMemo(
    () =>
      modelsForAgent(agent.id, null).filter(
        (row) =>
          row.value.length <= 256 &&
          /^[A-Za-z0-9][A-Za-z0-9._:/-]*(?:\[1m\])?$/.test(row.value),
      ),
    [agent.id],
  );
  const createIntent = useRef<{
    token: string;
    displayName: string;
    method: ConnectionMethod;
    id: string;
    operationId: string;
  } | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      createIntent.current = null;
      signIn.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!surfaceActive) {
      setOpen(false);
      setToken("");
      createIntent.current = null;
      signIn.current?.abort();
      setAuthStatus(null);
    }
  }, [surfaceActive]);
  const refresh = async () => {
    cloudOrganizationConnectionsCache.invalidate(key);
    invalidateCloudOrganizationAgentRegistry(organizationId);
    if (mounted.current) await snapshot.refresh();
  };
  const removal = useCloudCredentialRemoval({ userId, organizationId, active: surfaceActive, onRemoved: refresh });
  const busy = connectionBusy || removal.pending || !surfaceActive;
  const run = async (action: () => Promise<void>) => {
    if (inFlight.current || removal.isPending() || !surfaceActive || !removal.current()) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await action();
      await refresh();
    } catch (error) {
      if (
        mounted.current &&
        !(error instanceof DOMException && error.name === "AbortError")
      )
        toast.error(
          error instanceof Error ? error.message : "Cloud connection failed",
        );
      await refresh().catch(() => {});
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const connect = () =>
    run(async () => {
      if (!snapshot.data) return;
      let chosen = selected;
      if (!chosen) {
        const name =
          displayName.trim() ||
          `${agent.name} ${method === "apiKey" ? "API" : "account"}`;
        if (
          method === "account" &&
          (agent.id === "codex" || agent.id === "cursor")
        ) {
          const abort = new AbortController();
          signIn.current = abort;
          chosen = await connectCloudProviderSignIn(
            { organizationId, provider: agent.id, displayName: name },
            abort.signal,
            setAuthStatus,
          );
          abort.signal.throwIfAborted();
        } else {
          if (!token.trim()) return;
          if (
            createIntent.current?.token !== token.trim() ||
            createIntent.current.method !== method ||
            createIntent.current.displayName !== name
          )
            createIntent.current = {
              token: token.trim(),
              displayName: name,
              method,
              id: crypto.randomUUID(),
              operationId: crypto.randomUUID(),
            };
          chosen = (
            await saveCloudProviderCredential({
              ...createIntent.current,
              organizationId,
              agentId: agent.id,
              setupToken: method === "account",
            })
          ).credential;
        }
        if (mounted.current) {
          setSelected(chosen);
          setToken("");
        }
        createIntent.current = null;
      }
      await selectCloudOrganizationCredential(organizationId, agent.id, {
        expectedRevision: connection?.revision ?? 0,
        credentialId: chosen.id,
        credentialRevision: chosen.revision,
        models: models.slice(0, 32).map((row) => row.value),
        allModels: true,
        consent: "zeros-managed",
      });
      if (mounted.current) {
        setOpen(false);
        toast.success(`${agent.name} connected`);
      }
    });
  const disconnect = async () => {
    if (busy || inFlight.current || !connection) return;
    await removal.start(cloudProviderDisconnectTarget(organizationId, agent.id, connection));
  };
  const remove = async (credential: CloudProviderCredential) => {
    if (busy || inFlight.current) return;
    await removal.start(cloudOrganizationCredentialRemovalTarget(organizationId, credential));
  };
  const configure = (credential: CloudProviderCredential | null) => {
    setSelected(credential);
    setToken("");
    setDisplayName("");
    setAuthStatus(null);
    createIntent.current = null;
    setMethod(
      !credential ||
        credential.connectionMethod === "account" ||
        credential.kind === "claude-setup-token" ||
        credential.kind === "codex-chatgpt"
        ? "account"
        : "apiKey",
    );
    setOpen(true);
  };
  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div className="text-fg1 flex items-center gap-3 text-sm font-medium">
          <AgentIcon agentId={agent.id} iconUrl={null} className="size-5" />
          {agent.name}
        </div>
        <Button
          variant="secondary"
          onClick={() => configure(null)}
          disabled={!snapshot.data || busy}
        >
          {matching.length ? "Add account" : "Connect"}
        </Button>
      </div>
      <p className="text-fg2 text-xs">
        Your accounts are private. Choose one for your sessions in this
        organization.
      </p>
      <NativeBrowserAvailability provider={agent.id} />
      {snapshot.error && (
        <div className="flex items-center justify-between gap-3">
          <p className="text-red-primary text-xs" role="alert">
            {snapshot.error.message}
          </p>
          <Button variant="ghost" onClick={() => void snapshot.refresh()}>
            Retry
          </Button>
        </div>
      )}
      {matching.map((credential) => {
        const active =
          connection?.connected && connection.credentialId === credential.id;
        return (
          <div
            key={credential.id}
            className="border-border1 flex flex-col gap-3 border-b py-3"
          >
            <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-fg1 truncate text-sm">
                {credential.displayName}
              </div>
              <div className="text-fg2 text-xs">
                {active ? "Connected" : "Saved"} ·{" "}
                {credential.connectionMethod === "account" ||
                !credential.kind.endsWith("api-key")
                  ? "Account"
                  : "API"}
              </div>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => configure(credential)}
              >
                {active ? "Configure" : "Use account"}
              </Button>
              {active ? (
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void disconnect()}
                >
                  Disconnect
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void remove(credential)}
                >
                  Remove
                </Button>
              )}
            </div>
            </div>
            {canManageReleaseChecks && <ReleaseCanaryControl key={`${credential.id}:${credential.revision}`} userId={userId}
              organizationId={organizationId} credential={credential} surfaceActive={surfaceActive} />}
          </div>
        );
      })}
      <CloudCredentialRemovalDialog state={removal.state} active={surfaceActive && removal.current()}
        busy={removal.busy} onDecision={action => { void removal.decide(action); }} />
      <ProviderConnectionDialog
        provider={agent.id}
        name={agent.name}
        open={surfaceActive && open}
        onOpenChange={(value) => {
          setOpen(value);
          if (!value) {
            setToken("");
            createIntent.current = null;
            signIn.current?.abort();
            setAuthStatus(null);
          }
        }}
        method={method}
        onMethodChange={(value) => {
          setMethod(value);
          setSelected(null);
          setToken("");
          createIntent.current = null;
        }}
        connected={connection?.connected ?? false}
        busy={busy}
        methodOptions={[
          {
            id: "account",
            label: "Account",
            description: "Connect your subscription.",
          },
          {
            id: "apiKey",
            label: "API",
            description: "Connect with an API key.",
          },
        ]}
      >
        {selected ? (
          <p className="text-fg1 text-sm">{selected.displayName}</p>
        ) : (
          <>
            <Input
              aria-label="Account name"
              placeholder="Account name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              maxLength={80}
              disabled={busy}
            />
            {method === "account" && agent.id === "claude" && (
              <p className="text-fg2 text-xs">
                Run <code>claude setup-token</code> and paste the token here.
                Add another account to use a different subscription.
              </p>
            )}
            {method === "account" && agent.id === "codex" && (
              <p className="text-fg2 text-xs">
                Enable device code authorization in ChatGPT Settings → Security.
                Connect, then enter the code on the verification page.
              </p>
            )}
            {method === "account" && agent.id === "cursor" && (
              <p className="text-fg2 text-xs">
                Continue with your Cursor account in your browser.
              </p>
            )}
            {(method === "apiKey" || agent.id === "claude") && (
              <Input
                type="password"
                autoComplete="off"
                aria-label={
                  method === "account" ? "Cloud setup token" : "Cloud API key"
                }
                placeholder={
                  method === "account" ? "Paste setup token" : "Paste API key"
                }
                value={token}
                onChange={(event) => setToken(event.target.value)}
                disabled={busy}
              />
            )}
          </>
        )}
        {authStatus?.deviceCode && (
          <div className="bg-bg2 flex flex-col gap-3 rounded-md p-3">
            <p className="text-fg2 text-xs">
              Enter this code after signing in:
            </p>
            <div className="flex items-center justify-between gap-3">
              <code className="text-fg1 text-sm">
                {authStatus.deviceCode.userCode}
              </code>
              <Button
                variant="ghost"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(authStatus.deviceCode!.userCode)
                    .catch(() => toast.error("Could not copy code"))
                }
              >
                Copy code
              </Button>
            </div>
            <Button
              variant="secondary"
              onClick={() =>
                void shellOpenUrl(authStatus.deviceCode!.verificationUrl).catch(
                  () => toast.error("Could not open verification page"),
                )
              }
            >
              Open verification page
            </Button>
          </div>
        )}
        <p className="text-fg2 text-xs">
          Connecting stores this account encrypted in the cloud for your sessions
          on Zeros-managed computers in this organization, until you disconnect.
        </p>
        <div className="flex justify-end gap-2">
          {busy && authStatus && (
            <Button variant="secondary" onClick={() => signIn.current?.abort()}>
              Cancel
            </Button>
          )}
          <Button
            disabled={
              busy ||
              !snapshot.data ||
              (!selected &&
                !token.trim() &&
                (method === "apiKey" || agent.id === "claude"))
            }
            onClick={() => void connect()}
          >
            {busy ? "Connecting…" : "Connect"}
          </Button>
        </div>
      </ProviderConnectionDialog>
    </section>
  );
}
