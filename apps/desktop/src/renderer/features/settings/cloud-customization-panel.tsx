import { useState } from "react";
import { Button, Input } from "../../shared/ui";
import { CodeTextarea } from "../../shared/ui/primitives";
import { CloudMcpServerSchema, CloudSkillSchema } from "@zeros/protocol/cloud-customization";
import { SettingsSection, SettingsList, SettingsRow } from "./settings-ui";
import { useActiveOrganization, useTeams, getOrganizationStoreGeneration } from "../team/team-store";
import { useCachedRead } from "../../state/use-cached-read";
import { cloudCustomizationCache, cloudCustomizationKey, readCloudCustomization, saveCloudCustomization, customizationDocument,
  type CloudCustomizationSettings, type CloudCustomizationView, type CloudCustomizationDocument } from "./cloud-customization-client";

export const CloudMcpPanel = ({ surfaceActive = true }: { surfaceActive?: boolean }) => <CloudCustomizationPanel active={surfaceActive} kind="servers" />;
export const CloudSkillsPanel = ({ surfaceActive = true }: { surfaceActive?: boolean }) => <CloudCustomizationPanel active={surfaceActive} kind="skills" />;
function CloudCustomizationPanel({ active, kind }: { active: boolean; kind: "servers" | "skills" }) {
  const org = useActiveOrganization(), { me } = useTeams();
  return org && !org.isPersonal && me ? <CloudCustomizationScope key={cloudCustomizationKey(me.user.id, org.id)} user={me.user.id} org={org.id} active={active} kind={kind} /> : null;
}
function CloudCustomizationScope({ user, org, active, kind }: { user: string; org: string; active: boolean; kind: "servers" | "skills" }) {
  const key = cloudCustomizationKey(user, org);
  const snapshot = useCachedRead(cloudCustomizationCache, key, key => readCloudCustomization((JSON.parse(key) as string[])[1]!), { enabled: active, maxAgeMs: 30000 });
  const [scope, setScope] = useState<"organization" | "member">("organization");
  return <div className="flex flex-col gap-6">
    <SettingsSection title={kind === "servers" ? "MCP servers" : "Skills"} description={kind === "servers" ?
      "Cloud agents use organization, member, and repository servers. Repository declarations take precedence for the same name. OAuth sign-in is not supported yet; use headers for remote authentication." :
      "Saved skills are available to Claude, Codex and Cursor in organization cloud workspaces. Member skills override organization skills with the same name."}>
      <div className="flex gap-2">
        <Button variant={scope === "organization" ? "secondary" : "ghost"} onClick={() => setScope("organization")}>Organization</Button>
        <Button variant={scope === "member" ? "secondary" : "ghost"} onClick={() => setScope("member")}>Only me</Button>
      </div>
    </SettingsSection>
    {snapshot.error && <SettingsRow hint={snapshot.error.message}><Button variant="ghost" onClick={snapshot.refresh}>Retry</Button></SettingsRow>}
    {snapshot.data ? <CustomizationEditor key={`${scope}:${kind}`} org={org} cacheKey={key} scope={scope} kind={kind} settings={snapshot.data} active={active} /> :
      snapshot.loading && <p className="text-fg2 text-xs" role="status">Loading customization…</p>}
    {kind === "skills" && <SettingsSection title="Cursor team settings" description="Cursor account team settings and extension plugins are not imported. Organization skills are managed here; device preferences remain in Local Settings." />}
  </div>;
}
function CustomizationEditor({ org, cacheKey, scope, kind, settings, active }: {
  org: string; cacheKey: string; scope: "organization" | "member"; kind: "servers" | "skills"; settings: CloudCustomizationSettings; active: boolean;
}) {
  const view = settings[scope], canEdit = active && (scope === "member" || settings.canManage);
  const [selected, setSelected] = useState<string | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [draftRevision, setDraftRevision] = useState(view.revision);
  async function save(document: CloudCustomizationDocument, revision: number) {
    if (!canEdit || busy) return;
    const generation = getOrganizationStoreGeneration(); setBusy(true); setError("");
    try {
      const next = await saveCloudCustomization(org, scope, revision, document);
      if (generation !== getOrganizationStoreGeneration()) return;
      cloudCustomizationCache.setData(cacheKey, { ...(cloudCustomizationCache.getSnapshot(cacheKey).data ?? settings), [scope]: next });
      setSelected(null);
    } catch { if (generation === getOrganizationStoreGeneration()) setError("Could not save customization. Reload to check for changes and try again."); }
    finally { setBusy(false); }
  }
  const rows = kind === "servers" ? view.servers : view.skills;
  return <SettingsSection action={canEdit && <Button disabled={busy} onClick={() => { setDraftRevision(view.revision); setSelected(""); }}>Add {kind === "servers" ? "server" : "skill"}</Button>}>
    {error && <p role="alert" className="text-error text-xs">{error}</p>}
    <SettingsList>{rows.map(row => <SettingsRow key={row.name} label={row.name}
      hint={"transport" in row ? `${row.transport}${row.secretRef ? " · credentials saved" : ""}` : undefined}>
      <Button variant="ghost" disabled={!canEdit || busy} onClick={() => { setDraftRevision(view.revision); setSelected(row.name); }}>Edit</Button>
      <Button variant="ghost" disabled={!canEdit || busy} onClick={() => { const document = customizationDocument(view);
        if (kind === "servers") document.servers = document.servers.filter(item => item.name !== row.name);
        else document.skills = document.skills.filter(item => item.name !== row.name);
        void save(document, view.revision); }}>Remove</Button>
    </SettingsRow>)}</SettingsList>
    {!rows.length && <p className="text-fg2 text-xs">No {kind === "servers" ? "MCP servers" : "skills"} saved in this scope.</p>}
    {scope === "organization" && !settings.canManage && <p className="text-fg2 text-xs">Organization administrators can edit these settings.</p>}
    {selected !== null && <CustomizationForm key={`${selected}:${draftRevision}`} view={view} kind={kind} name={selected}
      disabled={!canEdit || busy} onCancel={() => setSelected(null)} onSave={document => void save(document, draftRevision)} />}
  </SettingsSection>;
}
function CustomizationForm({ view, kind, name, disabled, onSave, onCancel }: { view: CloudCustomizationView; kind: "servers" | "skills"; name: string; disabled: boolean;
  onSave(document: CloudCustomizationDocument): void; onCancel(): void }) {
  const document = customizationDocument(view), existing = document[kind].find(row => row.name === name);
  const [skillName, setSkillName] = useState(name), [content, setContent] = useState(kind === "servers" ? JSON.stringify(existing ? (({ id: _id, ...server }) => server)(existing as CloudCustomizationDocument["servers"][number]) :
    { name: "my-server", transport: "stdio", command: "node", args: ["server.mjs"] }, null, 2) : existing && "content" in existing ? existing.content : "");
  const [secretMap, setSecretMap] = useState(""), [error, setError] = useState("");
  const [description, setDescription] = useState(existing && "description" in existing ? existing.description ?? "" : "");
  function submit() {
    try {
      if (kind === "skills") {
        const skill = CloudSkillSchema.parse({ name: skillName, description, content });
        document.skills = [...document.skills.filter(row => row.name !== name), skill];
      } else {
        const raw = JSON.parse(content), secrets: unknown = secretMap.trim() ? JSON.parse(secretMap) : undefined;
        const server = CloudMcpServerSchema.parse({ ...raw, ...(secrets ? raw.transport === "stdio" ? { env: secrets } : { headers: secrets } : {}) });
        document.servers = [...document.servers.filter(row => row.name !== name), { ...server, id: existing && "id" in existing ? existing.id : crypto.randomUUID() }];
      }
      onSave(document); setSecretMap("");
    } catch { setError("Check the name and configuration. OAuth and implicit environment references are not supported."); }
  }
  return <div className="flex flex-col gap-3">
    {kind === "skills" && <Input aria-label="Skill name" value={skillName} onChange={event => setSkillName(event.target.value)} disabled={disabled} />}
    {kind === "skills" && <Input aria-label="When to use this skill" placeholder="Describe when agents should use this skill" value={description} onChange={event => setDescription(event.target.value)} disabled={disabled} />}
    <CodeTextarea aria-label={kind === "servers" ? "Server configuration (JSON)" : "Skill content"} value={content} onChange={setContent} readOnly={disabled} />
    {kind === "servers" && <SettingsRow label="Credentials" hint="Environment or header values as a JSON object. Leave blank to keep saved values; use {} to remove them.">
      <Input type="password" autoComplete="off" aria-label="MCP credentials JSON" value={secretMap} onChange={event => setSecretMap(event.target.value)} disabled={disabled} />
    </SettingsRow>}
    {error && <p role="alert" className="text-error text-xs">{error}</p>}
    <div className="flex gap-2"><Button disabled={disabled} onClick={submit}>Save</Button><Button variant="ghost" onClick={onCancel}>Cancel</Button></div>
  </div>;
}
