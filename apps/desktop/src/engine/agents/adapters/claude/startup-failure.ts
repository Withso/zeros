/** Native startup reasons identify the remedy more precisely than prose which
 * may itself mention sign-in or network troubleshooting. Do not invalidate
 * authentication for policy, workspace, or local-runtime failures. */
const STARTUP_RECOVERY: Record<string, { category: "auth-required" | "protocol-error"; advice: string }> = {
  gateway_signin_required: { category: "auth-required", advice: "Sign in to your configured Claude gateway again, then retry." },
  gateway_access_denied: { category: "protocol-error", advice: "Contact your organization's administrator to enable Claude access, then retry." },
  org_pin_api_key_conflict: { category: "protocol-error", advice: "Remove the conflicting API credential and use the organization sign-in required by your administrator." },
  org_verify_failed: { category: "protocol-error", advice: "Check the connection and your required organization sign-in, then retry." },
  org_pin_mismatch: { category: "protocol-error", advice: "Sign in using an organization allowed by your administrator, then retry." },
  managed_settings_invalid: { category: "protocol-error", advice: "Ask your administrator to correct the managed Claude settings, then retry." },
  remote_settings_required_unavailable: { category: "protocol-error", advice: "Restore access to the required managed settings, then retry." },
  proxy_invalid: { category: "protocol-error", advice: "Correct or remove the invalid proxy configuration, then retry." },
  temp_dir_unusable: { category: "protocol-error", advice: "Restore access to Claude's temporary directory, then retry." },
  cwd_unavailable: { category: "protocol-error", advice: "Restore the workspace directory or open an accessible workspace, then retry." },
  shell_tool_missing: { category: "protocol-error", advice: "Install or enable a shell supported by Claude on this machine, then retry." },
  session_held_by_background: { category: "protocol-error", advice: "Wait for the existing background session to finish, or stop it, before retrying." },
  worktree_resume_refused: { category: "protocol-error", advice: "Check the original worktree and Claude's explanation before resuming this chat." },
  worktree_unverified: { category: "protocol-error", advice: "Restore and verify the original worktree before resuming this chat." },
  cli_version_too_old: { category: "protocol-error", advice: "Update the configured Claude runtime or Zeros to a supported version, then retry." },
  bypass_root: { category: "protocol-error", advice: "Run Claude as a regular user instead of root when using bypass permissions." },
};

export function claudeStartupRecovery(code: string | undefined) {
  return code && Object.hasOwn(STARTUP_RECOVERY, code) ? STARTUP_RECOVERY[code] : undefined;
}
