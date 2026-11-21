// Every repository the caller's GitHub connections can read, to pick a
// project's repositories from. There is no step that adds a repository to the
// cloud: a connection lists what it can read and a project picks from that.
// An organization project picks only through the organization's connections; a
// project only for the caller may also use their own.
import { useMemo, useState } from "react";
import { Input } from "../../shared/ui";
import { Checkbox } from "../../shared/ui/primitives/checkbox";
import { MessageRow } from "../../shared/ui/primitives/message-row";
import { KeyedAsyncCache } from "../../shared/lib/keyed-async-cache";
import { useRecoveringRead } from "../../state/use-recovering-read";
import {
  getCloudGithubConnectionRepositories, type CloudGithubConnectionRepositories, type CloudGithubLevelConnections,
} from "../../platform/cloud-github-levels";
import { message } from "./cloud-computer-store";

type Row = CloudGithubConnectionRepositories["repositories"][number];
/** A connection's readable repositories, up to ten pages of a hundred. */
export const readableRepositoriesCache = new KeyedAsyncCache<Row[]>({ maxEntries: 32 });
const MAX_PAGES = 10;

async function readAll(organizationId: string, connectionId: string): Promise<Row[]> {
  const rows: Row[] = [];
  let page: number | null = 1;
  for (let read = 0; page !== null && read < MAX_PAGES; read++) {
    const reply: CloudGithubConnectionRepositories = await getCloudGithubConnectionRepositories(organizationId, connectionId, page);
    rows.push(...reply.repositories);
    page = reply.nextPage;
  }
  return rows;
}

/** The connections a project at this level picks through: active ones only. */
export function pickableConnections(connections: CloudGithubLevelConnections | null | undefined, level: "organization" | "personal") {
  if (!connections) return [];
  const own = level === "personal" ? connections.personal.filter(connection => connection.mine) : [];
  return [...connections.organization, ...own].filter(connection => connection.state === "active" && connection.installationId !== null);
}

/** One connection's repositories, read once per (caller, organization, connection). */
function useConnectionRows(userKey: string, organizationId: string, connectionId: string, active: boolean) {
  const key = JSON.stringify([userKey, organizationId, connectionId]);
  return useRecoveringRead(readableRepositoriesCache, key, () => readAll(organizationId, connectionId), { enabled: active, maxAgeMs: 60_000 });
}

export function ProjectRepositoryPicker({ id, userKey, organizationId, connections, level, chosen, onToggle, exclude, limit, active }: {
  /** A Field's label names the search input. */
  id?: string; "aria-describedby"?: string;
  userKey: string; organizationId: string; connections: CloudGithubLevelConnections | null | undefined; level: "organization" | "personal";
  /** Lowercased `owner/name`. */
  chosen: ReadonlySet<string>; onToggle(repository: string): void;
  /** Already in the project: not offered again. */
  exclude?: ReadonlySet<string>; limit: number; active: boolean;
}) {
  const [query, setQuery] = useState("");
  const list = pickableConnections(connections, level);
  return (
    <div className="flex min-h-0 flex-col gap-2">
      <Input id={id} aria-label="Search repositories" placeholder="Search repositories" value={query} onChange={event => setQuery(event.target.value)} />
      <div className="border-border1 flex max-h-80 min-h-40 flex-col gap-3 overflow-y-auto rounded-lg border p-2" role="group" aria-label="Repositories">
        {list.length === 0 && (
          <p className="text-fg3 m-0 p-2 text-xs">
            {level === "organization" ? "Connect a GitHub organization in Settings → GitHub first." : "Connect GitHub in Settings → GitHub first."}
          </p>
        )}
        {list.map(connection => (
          <ConnectionRepositories key={connection.id} userKey={userKey} organizationId={organizationId} connectionId={connection.id}
            account={connection.accountLogin} query={query} chosen={chosen} onToggle={onToggle} exclude={exclude}
            full={chosen.size >= limit} active={active} />
        ))}
      </div>
      <p className="text-fg3 m-0 text-xs">Every repository your GitHub connections can read. A project holds up to {limit}.</p>
    </div>
  );
}

function ConnectionRepositories({ userKey, organizationId, connectionId, account, query, chosen, onToggle, exclude, full, active }: {
  userKey: string; organizationId: string; connectionId: string; account: string; query: string;
  chosen: ReadonlySet<string>; onToggle(repository: string): void; exclude?: ReadonlySet<string>; full: boolean; active: boolean;
}) {
  const read = useConnectionRows(userKey, organizationId, connectionId, active);
  const needle = query.trim().toLowerCase();
  const rows = useMemo(() => (read.data ?? []).filter(row => !exclude?.has(row.repository.toLowerCase())
    && (!needle || row.repository.toLowerCase().includes(needle))), [read.data, exclude, needle]);
  if (read.error && !read.data) return <MessageRow tone="error" flush>{`${account}: ${message(read.error)}`}</MessageRow>;
  if (!read.data) return <p className="text-fg3 m-0 px-2 text-xs">{`Reading ${account}…`}</p>;
  if (rows.length === 0) return null;
  return (
    <section className="flex flex-col gap-1" aria-label={account}>
      <h4 className="text-fg3 m-0 px-2 text-xs font-medium">{account}</h4>
      {rows.map(row => {
        const name = row.repository.toLowerCase(), on = chosen.has(name);
        return (
          <Checkbox key={row.id} checked={on} disabled={!on && full} onChange={() => onToggle(name)}
            // The account is the group's header: each row names its repository.
            label={row.repository.split("/")[1] ?? row.repository} hint={row.private ? "Private" : "Public"} className="px-2" />
        );
      })}
    </section>
  );
}
