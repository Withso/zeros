import { randomUUID } from "node:crypto";

import type { BridgeClient } from "./bridge-client";

export type PtyCommandClient = Pick<
  BridgeClient,
  "onPtyData" | "ptyCreate" | "ptyWrite"
>;

function markerPrintCommand(marker: string): string {
  const split = Math.ceil(marker.length / 2);
  return `printf '\\n%s%s\\n' '${marker.slice(0, split)}' '${marker.slice(split)}'`;
}

export async function runPtyCommand(
  client: PtyCommandClient,
  workspaceId: string,
  command: string,
): Promise<void> {
  const sessionId = `validation-command-${randomUUID().slice(0, 8)}`;
  const success = `ZEROS_COMMAND_OK_${randomUUID().replaceAll("-", "")}`;
  const failed = `ZEROS_COMMAND_FAILED_${randomUUID().replaceAll("-", "")}`;
  const printSuccess = markerPrintCommand(success);
  const printFailure = markerPrintCommand(failed);
  await client.ptyCreate({ sessionId, cwd: workspaceId, ephemeral: true });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("PTY qualification command timed out")),
      20_000,
    );
    let output = "";
    client.onPtyData((candidate, data) => {
      if (candidate !== sessionId) return;
      output = `${output}${data}`.slice(-8_192);
      if (output.includes(success)) {
        clearTimeout(timer);
        resolve();
      } else if (output.includes(failed)) {
        clearTimeout(timer);
        reject(new Error("PTY qualification command failed"));
      }
    });
    try {
      client.ptyWrite(
        sessionId,
        `${command} && ${printSuccess} || ${printFailure}\n`,
      );
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
}
