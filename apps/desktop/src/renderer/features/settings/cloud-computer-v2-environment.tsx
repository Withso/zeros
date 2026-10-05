import { useState } from "react";
import { CloudComputerV2EnvironmentOperationSchema } from "@zeros/protocol/cloud-computer-v2";
import { Button, Input } from "../../shared/ui";
import { SettingsSection, SettingsList, SettingsRow } from "./settings-ui";
import {
  cloudComputerV2EnvironmentRows,
  type CloudComputerV2Editor,
} from "./cloud-computer-v2-editor";
import type { CloudComputerV2EnvironmentOperation } from "@zeros/protocol/cloud-computer-v2";

export function CloudComputerV2Environment({
  editor,
  editable,
  onChange,
}: {
  editor: CloudComputerV2Editor;
  editable: boolean;
  onChange: (operation: CloudComputerV2EnvironmentOperation) => void;
}) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [replace, setReplace] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const useValue = () => {
    const operation = CloudComputerV2EnvironmentOperationSchema.safeParse({
      op: "set",
      name: replace ?? name.trim(),
      value,
    });
    if (!operation.success) {
      setError(true);
      return;
    }
    onChange(operation.data);
    setValue("");
    setName("");
    setReplace(null);
    setError(false);
  };
  return (
    <SettingsSection
      title="Environment"
      description="Values stay hidden after saving. Built changes apply to new workspaces; environment values are not supplied to the privileged build."
    >
      <SettingsList>
        {cloudComputerV2EnvironmentRows(editor).map((row) => (
          <SettingsRow
            key={row.name}
            label={row.name}
            hint={row.set ? "Set" : "Not set"}
          >
            <Button
              variant="secondary"
              disabled={!editable}
              onClick={() => {
                setReplace(row.name);
                setValue("");
                setError(false);
              }}
            >
              Replace
            </Button>
            <Button
              variant="ghost"
              disabled={!editable}
              aria-label={`Remove environment ${row.name}`}
              onClick={() => {
                onChange({ op: "remove", name: row.name });
                if (replace === row.name) {
                  setReplace(null);
                  setValue("");
                }
              }}
            >
              Remove
            </Button>
          </SettingsRow>
        ))}
      </SettingsList>
      {editable && (
        <div className="flex flex-col gap-2">
          {replace ? (
            <div className="flex items-center justify-between gap-2">
              <span className="text-fg2 text-xs">Replace {replace}</span>
              <Button
                variant="ghost"
                onClick={() => {
                  setReplace(null);
                  setValue("");
                }}
              >
                Cancel replacement
              </Button>
            </div>
          ) : (
            <Input
              aria-label="Environment variable name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="VARIABLE_NAME"
              autoComplete="off"
              spellCheck={false}
            />
          )}
          <div className="flex items-center gap-2">
            <Input
              type="password"
              aria-label={
                replace
                  ? `Replacement value for ${replace}`
                  : "New environment value"
              }
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder="Value"
              autoComplete="new-password"
              spellCheck={false}
            />
            <Button
              variant="secondary"
              disabled={!value || (!replace && !name.trim())}
              onClick={useValue}
            >
              Use value
            </Button>
          </div>
          {error && (
            <p className="text-error text-xs" role="alert">
              Use a supported environment name and a nonempty value of at most
              64 KiB.
            </p>
          )}
        </div>
      )}
    </SettingsSection>
  );
}
