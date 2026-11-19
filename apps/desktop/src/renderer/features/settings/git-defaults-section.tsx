import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  SettingsSection,
  SettingsList,
  SettingsField,
  SETTINGS_CARD_LIST_CLS,
} from "./settings-ui";
import {
  useResolvedSettings,
  useSettingsLayer,
  useSyncedDraft,
} from "./use-settings";
import { cn } from "../../shared/ui/cn";
import { badgeVariants } from "../../shared/ui/primitives/badge";
import { toast } from "../../shared/ui/primitives/elements";
import { Input } from "../../shared/ui/primitives/input";
import {
  RadioGroup,
  RadioGroupItem,
} from "../../shared/ui/primitives/radio-group";
import {
  DEFAULT_BRANCH_PREFIX,
  joinBranchPrefix,
  normalizeBranchPrefix,
} from "../../shared/lib/branch-name";
import { useGithubLogin } from "./use-github-login";

// Mirror the engine schema without pulling it into the renderer bundle.
export type BranchPrefixType = "zeros" | "github" | "custom" | "none";

export const OPTIONS: Array<Exclude<BranchPrefixType, "zeros">> = [
  "github",
  "custom",
  "none",
];

const OPTIMISTIC_HOLD_MS = 3_000;

export function GitDefaultsSection() {
  const resolved = useResolvedSettings();
  // Branch naming is a personal default applied only at allocation.
  const { write } = useSettingsLayer("user");
  const login = useGithubLogin();

  const effective = resolved.resolved?.effective as
    | { git?: { branch_prefix_type?: unknown; branch_prefix?: unknown } }
    | undefined;
  const savedType = readType(effective?.git?.branch_prefix_type);
  const previewType = readPreviewType(effective?.git?.branch_prefix_type);
  const savedPrefix =
    typeof effective?.git?.branch_prefix === "string"
      ? effective.git.branch_prefix
      : "";

  const [pending, setPending] = useState<BranchPrefixType | null>(null);
  const selected = pending ?? savedType;

  // An echo for a different pick must not roll back the current selection.
  useEffect(() => {
    if (pending !== null && savedType === pending) setPending(null);
  }, [pending, savedType]);

  // A higher settings layer can prevent the user-layer write from ever taking effect.
  useEffect(() => {
    if (pending === null) return;
    const timer = setTimeout(() => setPending(null), OPTIMISTIC_HOLD_MS);
    return () => clearTimeout(timer);
  }, [pending]);

  // Keep the draft in the parent so the engine-rule preview follows unsaved typing.
  const [draft, setDraft] = useSyncedDraft(savedPrefix);

  // Restoring a saved Custom selection must not steal focus.
  const [focusCustom, setFocusCustom] = useState(false);

  // An older write failure must not clear the latest pick.
  const clickSeq = useRef(0);

  const select = (next: BranchPrefixType) => {
    if (next === selected) return;
    const mine = (clickSeq.current += 1);
    setPending(next);
    setFocusCustom(next === "custom");
    void write({ git: { branch_prefix_type: next } }).catch(() => {
      if (clickSeq.current !== mine) return;
      toast.error("Couldn't save the branch name prefix");
      setPending(null);
    });
  };

  return (
    <SettingsSection
      title="Branch name prefix"
      description="Prefix for new workspace branch names."
    >
      <SettingsList className={SETTINGS_CARD_LIST_CLS}>
        <SettingsField>
          <RadioGroup
            aria-label="Branch name prefix"
            value={selected}
            onValueChange={(v) => select(v as BranchPrefixType)}
          >
            {OPTIONS.map((value) => (
              <RadioGroupItem
                key={value}
                value={value}
                label={labelFor(value, login)}
              >
                {value === "custom" && selected === "custom" && (
                  <CustomPrefixInput
                    saved={savedPrefix}
                    draft={draft}
                    setDraft={setDraft}
                    write={write}
                    autoFocus={focusCustom}
                  />
                )}
              </RadioGroupItem>
            ))}
          </RadioGroup>
        </SettingsField>
      </SettingsList>
      <p className="text-fg2 text-xs">
        {previewFor(
          pending ?? previewType,
          selected === "custom" ? draft : savedPrefix,
          login,
        )}
      </p>
    </SettingsSection>
  );
}

function CustomPrefixInput({
  saved,
  draft,
  setDraft,
  write,
  autoFocus,
}: {
  saved: string;
  draft: string;
  setDraft: (v: string) => void;
  write: (patch: { git: { branch_prefix: string | null } }) => Promise<void>;
  autoFocus: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);

  // Escape blurs before React applies the reset, so guard against saving the old draft.
  const reverting = useRef(false);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  const commit = useCallback(() => {
    const next = draft.trim();
    if (next === saved) return;
    // Delete the key so the engine uses its fallback prefix.
    void write({ git: { branch_prefix: next || null } }).catch(() =>
      toast.error("Couldn't save the branch name prefix"),
    );
  }, [draft, saved, write]);

  return (
    <Input
      ref={ref}
      value={draft}
      onChange={(e) => {
        // A missed blur must not swallow the next commit.
        reverting.current = false;
        setDraft(e.target.value);
      }}
      onBlur={() => {
        if (reverting.current) {
          reverting.current = false;
          return;
        }
        commit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          reverting.current = true;
          setDraft(saved);
          e.currentTarget.blur();
        }
      }}
      spellCheck={false}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      placeholder="eg. name or product"
      aria-label="Custom branch name prefix"
    />
  );
}

export function readType(value: unknown): BranchPrefixType {
  return value === "custom" || value === "none" ? value : "github";
}

// A persisted "zeros" prefix has no radio row but must still preview accurately.
export function readPreviewType(value: unknown): BranchPrefixType {
  return value === "zeros" ? "zeros" : readType(value);
}

function labelFor(
  value: Exclude<BranchPrefixType, "zeros">,
  login: string | null,
): ReactNode {
  if (value === "github")
    // Use a span because the Radix radio button only permits phrasing content.
    return login ? (
      <span className="inline-flex items-center gap-1.5">
        GitHub username
        <span className={cn(badgeVariants({ variant: "neutral" }))}>
          {login}
        </span>
      </span>
    ) : (
      "GitHub username"
    );
  return value === "custom" ? "Custom" : "None";
}

export function previewFor(
  type: BranchPrefixType,
  prefix: string,
  login: string | null,
): string {
  const name = "Cream";
  const example = (namespace: string) =>
    `New branches will be named like ${joinBranchPrefix(namespace, name)}.`;
  switch (type) {
    case "none":
      return "New branches will have no prefix.";
    case "custom": {
      if (!prefix.trim()) return "Enter a prefix.";
      const namespace = normalizeBranchPrefix(prefix);
      return namespace
        ? example(namespace)
        : `That prefix isn't a valid git ref, so new branches will keep the fallback ${DEFAULT_BRANCH_PREFIX}/ prefix.`;
    }
    case "github":
      return login
        ? example(normalizeBranchPrefix(login) ?? DEFAULT_BRANCH_PREFIX)
        : `New branches will be named like ${joinBranchPrefix(
            DEFAULT_BRANCH_PREFIX,
            name,
          )} until you connect GitHub in Settings → Integrations.`;
    case "zeros":
    default:
      return example(DEFAULT_BRANCH_PREFIX);
  }
}
