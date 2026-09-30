import type { CloudAgentCredentialMaterial } from "./agent-credential-envelope.js";
import type { DevRenewalProof } from "./dev-native-canary.js";

type AccessVersion = { credential: { current_version: number }; material: CloudAgentCredentialMaterial };

export async function prepareNativeCanaryAccess<Version extends AccessVersion>(read: () => Promise<Version>, renew: () => Promise<void>, now = Date.now, headroomMs = 120_000) {
  let before = await read();
  if (before.material.kind !== "codex-chatgpt") return { before, renewedCodex: undefined, renewal: undefined };
  const live = (value: AccessVersion) => value.material.kind === "codex-chatgpt" && !value.material.refreshToken && value.material.expiresAt * 1000 > now() + headroomMs;
  const changed = (previous: AccessVersion, next: AccessVersion) => previous.material.kind === "codex-chatgpt" && next.material.kind === "codex-chatgpt" &&
    next.material.accountId === previous.material.accountId && next.material.accessToken !== previous.material.accessToken && next.credential.current_version > previous.credential.current_version;
  if (!live(before)) {
    await renew(); const bootstrap = await read();
    if (!changed(before, bootstrap) || !live(bootstrap)) throw new Error("Native renewal did not bootstrap live access material");
    before = bootstrap;
  }
  await renew(); const after = await read();
  if (!changed(before, after) || !live(before) || !live(after) || after.material.kind !== "codex-chatgpt") throw new Error("Native renewal did not publish bound live access material");
  const renewal: DevRenewalProof = { accountBinding: true, accessChanged: true, cachePublished: true, consentPreserved: true };
  return { before, renewedCodex: after.material, renewal };
}
