import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { bindFixture, verifyFixtureMembership } from "./hosted-fixtures.mjs";
import { localFixtureCredentials, verifyLocalGithub } from "./local-fixtures.mjs";
import { workosClient } from "./workos.mjs";
import { saveWorkspace } from "./state.mjs";
import { databaseCommand } from "./postgres.mjs";
import { cloudCredentialKeyring } from "./cloud-v2-keys.mjs";

/** The launcher calls this after API readiness, or for its explicit seed
 * action. All writes stay in the owned loopback DB. WorkOS/GitHub calls verify
 * existing test authority; a password login creates only a temporary session. */
export async function seedLocalEnvironment(workspace, profile, ports, repositoryRoot, options = {}) {
  if (workspace.state.status !== "active" || !workspace.state.launcher?.runId ||
      !Number.isInteger(ports.api) || ports.api < 1024 || ports.api > 65535) throw new Error("Start this electron:cloud backend before seeding");
  const module = options.module ?? (name => import(pathToFileURL(path.join(repositoryRoot, "apps/control-plane/dist", name))));
  const request = options.fetch ?? fetch, database = options.database ?? databaseCommand;
  const save = options.save ?? saveWorkspace;
  const { gate0LocalIdentity, gate0SignIn } = await module("cloud/gate0-cli.js");
  const origin = `http://127.0.0.1:${ports.api}`;
  const json = async (url, headers = {}) => {
    try {
      const response = await request(url, { redirect: "error", signal: globalThis.AbortSignal.timeout(20_000), headers });
      if (!response.ok) { await response.body?.cancel(); throw new Error(); }
      return await response.json();
    } catch { throw new Error("Local fixture verification failed; remote details were withheld"); }
  };
  gate0LocalIdentity(await json(`${origin}/healthz`), { owner: workspace.state.owner, runId: workspace.state.launcher.runId, apiPort: ports.api });
  let env;
  try { env = options.agentEnv ?? parseEnv(readFileSync(path.join(repositoryRoot, ".env.agent"), "utf8")); }
  catch { throw new Error("Local fixture seeding needs the private .env.agent file"); }
  const fixture = bindFixture(workspace.state, { ...profile.fixture, bootstrapOrganization: true });
  save(workspace);
  let session;
  try {
    if (env.ZEROS_DEV_PASSWORD) {
      session = await gate0SignIn({ clientId: profile.workos.webClientId, apiKey: profile.workos.apiKey,
        email: fixture.expectedEmail, subject: fixture.workosUserId, organizationId: fixture.workosOrganizationId,
        password: env.ZEROS_DEV_PASSWORD }, request);
      // Normal authenticated bootstrap creates the local user and verified
      // WorkOS identity. The fixture never fabricates those rows.
      await json(`${origin}/v1/me`, { authorization: `Bearer ${await session.accessToken()}` });
    }
    const github = profile.github;
    if (!github?.privateKeyBase64 || !github.clientId) throw new Error("The Alpha GitHub App is required for local fixture seeding");
    const { createGithubAppJwt } = await module("github-app-jwt.js");
    const jwt = createGithubAppJwt({ clientId: github.clientId, privateKey: Buffer.from(github.privateKeyBase64, "base64").toString("utf8") });
    const [fixtureProof, githubProof] = await Promise.all([
      verifyFixtureMembership(fixture, workosClient(profile, request)),
      verifyLocalGithub({ installationId: Number(env.ZEROS_DEV_GITHUB_INSTALLATION_ID), repository: env.ZEROS_DEV_REPOSITORY,
        appId: Number(github.appId) }, route => json(`https://api.github.com${route}`, {
        authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28",
      })),
    ]);
    return await database(workspace, ports, repositoryRoot, "seed", {
      fixture, fixtureProof, githubProof, credentials: localFixtureCredentials(env),
      encryptionKey: cloudCredentialKeyring(workspace.state).CLOUD_WORKSPACE_SECRET_KEY_V1,
    });
  } finally { await session?.close(); }
}
