import type { GithubAuthMethod } from "@zeros/protocol/github-auth";
import { Cloud, Laptop } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../shared/ui/primitives/select";
import { SettingsRow } from "./settings-ui";

export type GithubPlace = "local" | "cloud";

export const workspaceMethodNames = {
  "github-app": "GitHub App",
  pat: "Personal access token",
  "gh-cli": "GitHub CLI",
} satisfies Record<GithubAuthMethod, string>;

export function GithubWorkspaceMethod({
  place, organization, method, hint, disabled, methods, onChoose,
}: {
  place: GithubPlace;
  organization?: string;
  method: GithubAuthMethod | null;
  hint: string;
  disabled: boolean;
  methods: readonly GithubAuthMethod[];
  onChoose(method: GithubAuthMethod): void;
}) {
  const name = place === "local" ? "Local" : "Cloud";
  const Icon = place === "local" ? Laptop : Cloud;
  return (
    <SettingsRow label={organization ? `Cloud · ${organization}` : name} hint={hint} leading={<Icon className="size-4" aria-hidden />}>
      <Select value={method ?? ""} disabled={disabled} onValueChange={value => {
        const chosen = methods.find(candidate => candidate === value);
        if (chosen) onChoose(chosen);
      }}>
        <SelectTrigger aria-label={`${name} method`}>
          <SelectValue placeholder="Choose method" />
        </SelectTrigger>
        <SelectContent>
          {methods.map(choice => <SelectItem key={choice} value={choice}>{workspaceMethodNames[choice]}</SelectItem>)}
        </SelectContent>
      </Select>
    </SettingsRow>
  );
}
