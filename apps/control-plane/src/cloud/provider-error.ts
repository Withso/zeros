export class CloudProviderError extends Error {
  readonly retryAfterMs: number | undefined;
  readonly httpStatus: number | undefined;

  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
    options?: ErrorOptions & { retryAfterMs?: number | undefined; httpStatus?: number | undefined },
  ) {
    super(message, options);
    this.name = "CloudProviderError";
    this.retryAfterMs = options?.retryAfterMs;
    this.httpStatus = Number.isInteger(options?.httpStatus) && options!.httpStatus! >= 100 && options!.httpStatus! < 600 ? options!.httpStatus : undefined;
  }
}

