import { useState, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { Button } from "../../shared/ui";
import { MessageRow } from "../../shared/ui/primitives/message-row";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../../shared/ui/primitives/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../shared/ui/primitives/tabs";
import { KeyedAsyncCache } from "../../shared/lib/keyed-async-cache";
import { useRecoveringRead } from "../../state/use-recovering-read";
import { shellOpenUrl } from "../../platform/app";
import { disconnectCloudGithubConnection, getCloudGithubConnectionRepositories, type CloudGithubLevelConnection,
  type CloudGithubConnectionRepositories } from "../../platform/cloud-github-levels";
import { SettingsGroup, SettingsRow } from "./settings-ui";
import { message } from "./cloud-computer-store";

export const connectionRepositoriesCache = new KeyedAsyncCache<CloudGithubConnectionRepositories>({ maxEntries: 32 });
export const connectionRepositoryPageKey = (userId: string, organizationId: string, connectionId: string, page: number, generation?: string) =>
  JSON.stringify([userId, organizationId, connectionId, page, generation]);

export function GithubConnectionDrawer({ userId, organizationId, connection, canManage, personal, accountLogin, accountType, credentialGeneration, installUrl, accessNotice, onChanged, onClose }: {
  userId: string; organizationId: string; connection: CloudGithubLevelConnection; canManage: boolean; personal: boolean;
  accessNotice: ReactNode; accountLogin: string | undefined; accountType?: "User" | "Organization" | undefined; credentialGeneration: string | undefined; installUrl: string | null | undefined; onChanged(): void; onClose(): void;
}) {
  const [tab, setTab] = useState("general");
  const [page, setPage] = useState(1);
  const [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = connectionRepositoryPageKey(userId, organizationId, connection.id, page, credentialGeneration);
  // A saved suspension can be stale after the App is unsuspended on GitHub; the live read decides.
  const readable = connection.installationId !== null && connection.state !== "uninstalled";
  const read = useRecoveringRead(connectionRepositoriesCache, key,
    () => getCloudGithubConnectionRepositories(organizationId, connection.id, page),
    { enabled: tab === "repositories" && readable && !accessNotice, maxAgeMs: 15_000 });
  // The placement (Only you or organization) is independent of the installation owner.
  const manageUrl = !connection.installationId ? installUrl
    : connection.accountLogin.toLowerCase() === accountLogin?.toLowerCase() ? `https://github.com/settings/installations/${connection.installationId}`
    // Only an organization's installation has an organization settings page; GitHub's install page lists the rest.
    : accountType === "Organization" ? `https://github.com/organizations/${encodeURIComponent(connection.accountLogin)}/settings/installations/${connection.installationId}`
    : installUrl;
  const nextPage = read.data?.nextPage;
  const disconnect = async () => {
    if (!canManage || busy) return;
    setBusy(true); setError(null);
    try { await disconnectCloudGithubConnection(organizationId, connection.id); onChanged(); onClose(); }
    catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  };
  return <Sheet open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <SheetContent className="overflow-y-auto p-6">
      <SheetHeader><SheetTitle>@{connection.accountLogin}</SheetTitle>
        <SheetDescription>{connection.level === "personal" ? "Only you. Nobody else sees it, admins included."
          : personal ? "Used by your projects." : "Shared with your organization."}</SheetDescription>
      </SheetHeader>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList aria-label="Connection details"><TabsTrigger value="general">General</TabsTrigger><TabsTrigger value="repositories">Repositories</TabsTrigger></TabsList>
        <TabsContent value="general">
          {accessNotice}
          <SettingsGroup>
            <SettingsRow label="Repository access" hint={canManage ? "Choose which repositories Zeros can read." : `Managed on GitHub by @${connection.accountLogin}.`}>
              {canManage && manageUrl && <Button variant="secondary" onClick={() => void shellOpenUrl(manageUrl).catch(cause => setError(message(cause)))}>Manage on GitHub<ExternalLink aria-hidden /></Button>}
            </SettingsRow>
            {canManage && <SettingsRow label={confirm ? `Disconnect @${connection.accountLogin}?` : "Disconnect"}
              hint="Projects using it lose access to its repositories.">
              {confirm && <Button disabled={busy} variant="ghost" onClick={() => setConfirm(false)}>Cancel</Button>}
              <Button disabled={busy} variant={confirm ? "destructive" : "destructive-secondary"} onClick={() => confirm ? void disconnect() : setConfirm(true)}>Disconnect</Button>
            </SettingsRow>}
            {error && <MessageRow tone="error" role="alert" flush>{error}</MessageRow>}
          </SettingsGroup>
        </TabsContent>
        <TabsContent value="repositories">
          {accessNotice ?? <SettingsGroup description="Everything this connection can read. Nothing to add here: pick them when you create a project.">
            {!readable ? <SettingsRow label="Installation unavailable" /> : <>
              {read.loading && <MessageRow flush>Loading repositories…</MessageRow>}
              {read.error && <MessageRow tone="error" role="alert" flush>{message(read.error)}</MessageRow>}
              {read.data && !read.data.repositories.length && <SettingsRow label="No visible repositories" />}
              {read.data?.repositories.map(row => <SettingsRow key={row.id} label={row.repository}
                hint={[row.private ? "Private" : "Public", row.access === "write" ? "Write access" : row.access === "read" ? "Read access" : null].filter(Boolean).join(" · ")}>
                {row.projects.length > 0 && <span className="text-fg3 text-xs">{row.projects.length === 1 ? `In ${row.projects[0]!.name}` : `In ${row.projects.length} projects`}</span>}
              </SettingsRow>)}
              <div className="flex items-center gap-2">
                {page > 1 && <Button onClick={() => setPage(page - 1)}>Previous page</Button>}
                {nextPage && <Button onClick={() => setPage(nextPage)}>Next page</Button>}
                <Button variant="ghost" size="compact" onClick={read.refresh}>Refresh repositories</Button>
              </div>
            </>}
          </SettingsGroup>}
        </TabsContent>
      </Tabs>
    </SheetContent>
  </Sheet>;
}
