import { hostedDevGithubReferencesEnabled } from "../../github-auth-runtime";
import { restoreDevGithubBinding } from "../../github-app-flow";
import { requestCloudGithub } from "../../cloud-github-client";
import { refreshGithubAppCredential } from "../../github-app-flow";
import { controlPlaneBaseUrl } from "../../workos-desktop-account";
import { cloudWorkspaceDesktopCapabilityEnabled } from "../../../src/engine/cloud-workspace-capability";
import { getValidSessionForMain } from "./auth-session";
import type { CommandHandler } from "../router";

export const ghCloud: CommandHandler = (args) => {
  if (!cloudWorkspaceDesktopCapabilityEnabled())
    throw new Error("Cloud GitHub connections are unavailable in this build.");
  return requestCloudGithub(args, {
    session: getValidSessionForMain,
    credential: refreshGithubAppCredential,
    baseUrl: controlPlaneBaseUrl,
    fetch,
    ...(hostedDevGithubReferencesEnabled()?{reference:restoreDevGithubBinding}:{}),
  });
};
