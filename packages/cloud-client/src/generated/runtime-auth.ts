// GENERATED from docs/cloud-workspace/contracts/s3-client-contract.md (s3-runtime-auth-frames).
// Do not edit by hand; run `pnpm --dir packages/cloud-client generate`.

export type Uuid = string;

export type TimestampMs = number;

/** S1 capability (JWS compact) for the route's audience. */
export type Token = string;

export type Proof = {
  timestampMs: TimestampMs;
  nonce: string;
  signature: string;
};

export type Frame = {
  d: Record<string, unknown>;
  t: unknown;
};

export type ClientAuth = Frame & {
  t: "auth";
  d: {
    capability: Token;
    proof: Proof;
    clientSessionId: Uuid;
    contract: number;
    engine?: {
      capability: Token;
      proof: Proof;
    };
  };
};

export type ClientAuthRenew = Frame & {
  t: "auth.renew";
  d: {
    capability: Token;
    proof: Proof;
  };
};

export type ServerAuthOk = Frame & {
  t: "auth.ok";
  d: {
    sessionId: Uuid;
    scopes: string[];
    expiresAtMs: TimestampMs;
  };
};

export type ServerAuthRenewed = Frame & {
  t: "auth.renewed";
  d: {
    expiresAtMs: TimestampMs;
  };
};

export type RuntimeAuthClientFrame =
  | ClientAuth
  | ClientAuthRenew;

export type RuntimeAuthServerFrame =
  | ServerAuthOk
  | ServerAuthRenewed;

export type RuntimeAuthFrame = RuntimeAuthClientFrame | RuntimeAuthServerFrame;
export type RuntimeAuthFrameType = RuntimeAuthFrame["t"];
export type RuntimeAuthClientFrameType = RuntimeAuthClientFrame["t"];
export type RuntimeAuthServerFrameType = RuntimeAuthServerFrame["t"];
