// Production cloud connection controls with a synthetic desktop session.
// Browser smoke intercepts the HTTPS API; no credentials leave this harness.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";

const userId = "11111111-1111-4111-8111-111111111111";
const organizations = [
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
];
const fixture = { nativeCalls: [] as { command: string; url?: string }[] };
Object.assign(window, { cloudGithubFixture: fixture });
window.__ZEROS_NATIVE__ = {
  on: () => () => {},
  async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    fixture.nativeCalls.push({
      command,
      ...(command === "shell_open_url" ? { url: String(args?.url ?? "") } : {}),
    });
    if (command === "auth_get_access_token")
      return { access_token: "synthetic-cloud-session" } as T;
    if (command === "auth_get_session_user")
      return {
        sub: userId,
        accountId: userId,
        email: "fixture@example.test",
        name: "Fixture",
        provider: "workos",
      } as T;
    if (command === "shell_open_url") return null as T;
    throw new Error(
      `Unexpected native command in cloud GitHub harness: ${command}`,
    );
  },
};

async function main() {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { Button, TooltipProvider } = await import("../shared/ui/primitives");
  const { CloudGithubSection } =
    await import("../features/settings/cloud-github-section");
  const { CloudRepositoryPicker } =
    await import("../features/settings/cloud-repository-picker");

  function Panel({
    organizationId,
    active,
  }: {
    organizationId: string;
    active: boolean;
  }) {
    const [selection, setSelection] = React.useState<
      import("../features/settings/cloud-repository-picker").CloudRepositorySelection[]
    >([]);
    return (
      <div
        id="cloud-github-panel"
        hidden={!active}
        {...(!active ? { inert: "" } : {})}
      >
        <div className="flex flex-col gap-8">
          <CloudGithubSection
            userId={userId}
            organizationId={organizationId}
            surfaceActive={active}
          />
          <CloudRepositoryPicker
            userId={userId}
            organizationId={organizationId}
            value={selection}
            onChange={setSelection}
            active={active}
          />
        </div>
      </div>
    );
  }
  function Harness() {
    const [organization, setOrganization] = React.useState(0);
    const [active, setActive] = React.useState(true);
    return (
      <TooltipProvider>
        <main className="bg-bg1 min-h-screen p-8">
          <div className="mx-auto flex max-w-3xl flex-col gap-6">
            <div className="flex gap-2">
              {organizations.map((id, index) => (
                <Button
                  key={id}
                  variant="secondary"
                  aria-pressed={organization === index}
                  onClick={() => setOrganization(index)}
                >
                  Organization {index === 0 ? "A" : "B"}
                </Button>
              ))}
              <Button
                variant="ghost"
                onClick={() => setActive((value) => !value)}
              >
                {active ? "Hide cloud settings" : "Show cloud settings"}
              </Button>
            </div>
            <Panel
              key={organization}
              organizationId={organizations[organization]!}
              active={active}
            />
          </div>
        </main>
      </TooltipProvider>
    );
  }
  createRoot(document.getElementById("root")!).render(<Harness />);
}
void main();
