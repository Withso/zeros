import { afterEach, describe, expect, it, vi } from "vitest";

import { installIframeHeaderStripping } from "../iframe-headers";
import { previewFrameAuthorizations } from "../preview-frame-authorizations";

type BeforeSendHeadersDetails = {
  url: string;
  requestHeaders: Record<string, string>;
  frame: object;
};

type BeforeSendHeadersCallback = (result: {
  cancel: boolean;
  requestHeaders?: Record<string, string>;
}) => void;

afterEach(() => {
  previewFrameAuthorizations.clear();
});

describe("iframe request header admission", () => {
  it("calls back without capability headers when any frame ancestry getter throws", () => {
    let beforeSendHeaders:
      | ((
          details: BeforeSendHeadersDetails,
          callback: BeforeSendHeadersCallback,
        ) => void)
      | null = null;
    const session = {
      webRequest: {
        onBeforeSendHeaders: vi.fn(
          (
            _filter: unknown,
            listener: (
              details: BeforeSendHeadersDetails,
              callback: BeforeSendHeadersCallback,
            ) => void,
          ) => {
            beforeSendHeaders = listener;
          },
        ),
        onHeadersReceived: vi.fn(),
      },
    };
    installIframeHeaderStripping(session as never);
    expect(beforeSendHeaders).not.toBeNull();

    const origin = "https://0123456789abcdef0123456789abcdef.preview.test";
    expect(
      previewFrameAuthorizations.authorizeCloudPreview(
        {
          frameName: "zeros-browser-cloud-1",
          origin,
          expiresAt: Date.now() + 60_000,
          capability: `zwp_${"a".repeat(43)}`,
        },
        101,
      ),
    ).toBe(true);

    const frames = [
      Object.defineProperty({}, "frameTreeNodeId", {
        get: () => {
          throw new Error("frame disposed");
        },
      }),
      Object.defineProperties(
        {},
        {
          frameTreeNodeId: { get: () => 101 },
          parent: {
            get: () => {
              throw new Error("parent disposed");
            },
          },
        },
      ),
    ];

    for (const frame of frames) {
      const callback = vi.fn<BeforeSendHeadersCallback>();
      beforeSendHeaders!(
        {
          url: `${origin}/asset.js`,
          requestHeaders: { Accept: "*/*" },
          frame,
        },
        callback,
      );

      expect(callback).toHaveBeenCalledOnce();
      expect(callback).toHaveBeenCalledWith({ cancel: false });
    }
  });
});
