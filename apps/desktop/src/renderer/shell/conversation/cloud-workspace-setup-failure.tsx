import type { CloudWorkspaceDocument } from "../../platform/cloud-workspaces";

export function CloudWorkspaceSetupFailure({ failure }: {
  failure: NonNullable<CloudWorkspaceDocument["setupFailure"]>;
}) {
  const explanation = failure.code === "setup_image_contract_invalid"
    ? "The workspace image could not be verified."
    : failure.code === "setup_command_failed"
      ? "Your setup script failed."
      : "Cloud workspace setup could not finish.";
  return (
    <div role="alert" className="text-fg2 space-y-2 text-xs">
      <p className="text-red-primary font-medium">Setup failed</p>
      <p>{explanation}</p>
      <code className="block break-words">{failure.code}</code>
      {!failure.hasLog && <p>The failure happened before your setup script ran.</p>}
    </div>
  );
}
