import {
  cloudGithubRequestSchema,
  parseCloudGithubResponse,
  type GithubCredential,
} from "@zeros/protocol/github-auth";

type Session = {
  accessToken: string;
  sub: string;
  accountId?: string | undefined;
  sessionId?: string | undefined;
};
const owner = (session: Session) =>
  JSON.stringify([session.sub, session.accountId, session.sessionId]);
const copy: Record<string, string> = {
  github_cloud_write_denied: "Your GitHub account needs write access to this repository. Check your GitHub connection and try again.",
  github_cloud_access_denied:
    "GitHub could not verify access. Choose your own account or an organization you belong to. The GitHub App needs Members read permission for organizations.",
  github_cloud_account_not_owned:
    "You can connect your own GitHub account or an organization you belong to.",
  github_cloud_membership_required:
    "You must be an active member of this GitHub organization to connect it.",
  github_installation_suspended:
    "This GitHub installation is suspended. Restore it in GitHub before connecting.",
  github_installation_not_found:
    "Install the Zeros GitHub App for this account or organization, then refresh.",
  github_authorization_changed:
    "Your GitHub connection changed. Refresh and try again.",
  github_authorization_required:
    "Connect your GitHub account before choosing cloud repositories.",
  github_authorization_expired: "Reconnect your GitHub account to continue.",
};

/** Native-only credential courier. Its return value is a positive projection;
 * neither successful responses nor upstream error text can release credentials. */
export async function requestCloudGithub(
  value: unknown,
  deps: {
    session(): Promise<Session | null>;
    credential(): Promise<Extract<
      GithubCredential,
      { method: "github-app" }
    > | null>;
    baseUrl(): string;
    fetch: typeof fetch;
    reference?(organizationId:string):Promise<string>;
  },
) {
  const request = cloudGithubRequestSchema.parse(value);
  const session = await deps.session();
  if (!session) throw new Error("Sign in to Zeros to connect GitHub.");
  const reference=request.action!=="disconnect"&&deps.reference?await deps.reference(request.organizationId):null;
  const credential =
    request.action === "disconnect" || reference ? null : await deps.credential();
  if (
    request.action !== "disconnect" && !reference &&
    (!credential || credential.ownerSub !== (session.accountId ?? session.sub))
  )
    throw new Error(
      "Connect your GitHub account to choose cloud repositories.",
    );
  const assertSession = async () => {
    const current = await deps.session();
    if (!current || owner(current) !== owner(session))
      throw new Error("Your account changed. Try again.");
  };
  await assertSession();
  const response = await deps.fetch(`${deps.baseUrl()}/v1/github/cloud`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers: {
      authorization: `Bearer ${session.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      ...request,
      ...(reference?{devReference:reference}:credential ? { accessToken: credential.accessToken } : {}),
    }),
  });
  const reader = response.body?.getReader();
  if (!reader)
    throw new Error("GitHub returned an incomplete response. Try again.");
  let text = "",
    size = 0;
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 1024 * 1024) {
        await reader.cancel();
        throw new Error("GitHub returned too many results. Try again.");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  await assertSession();
  let body: unknown;
  try {
    body = JSON.parse(text + decoder.decode());
  } catch {
    throw new Error("GitHub returned an incomplete response. Try again.");
  }
  if (!response.ok) {
    const code =
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof body.error === "object" &&
      body.error !== null &&
      "code" in body.error
        ? body.error.code
        : null;
    throw new Error(
      typeof code === "string" && Object.hasOwn(copy, code)
        ? copy[code]
        : "GitHub access could not be verified. Reconnect GitHub or try again shortly.",
    );
  }
  return parseCloudGithubResponse(request, body);
}
