export interface ZsrPortPolicyControl {
  close(): Promise<void>;
}

export function startZsrPortPolicyControl(options: {
  readonly socketPath: string;
  readonly generation: string;
  readonly token: Buffer;
  readonly staticPorts: readonly number[];
  readonly deniedPorts: readonly number[];
  readonly onPorts: (effectivePorts: readonly number[]) => void;
}): Promise<ZsrPortPolicyControl>;
