import { describe, expect, it } from "vitest";

import {
  CloudProviderQualificationError,
  DaytonaProviderConnectionQualifier,
} from "./provider-qualification.js";

describe("delegated Daytona provider qualification", () => {
  const input = {
    apiKey: "daytona_delegated_credential_0123456789",
    apiUrl: "https://app.daytona.io/api",
    target: "eu",
  };

  it("derives coordinator capabilities from the current key permissions", async () => {
    const qualifier = new DaytonaProviderConnectionQualifier({
      clientFactory: () => ({
        currentApiKey: async () => ({
          permissions: ["write:sandboxes", "delete:sandboxes"],
          expiresAt: new Date(Date.now() + 86_400_000),
        }),
      }),
    });

    await expect(qualifier.qualify(input)).resolves.toEqual({
      capabilities: {
        qualified: true,
        qualificationVersion: 1,
        lifecycle: true,
        ssh: true,
        preview: true,
        commandExecution: true,
        daytonaTarget: "eu",
      },
      credentialExpiresAt: expect.stringMatching(/Z$/),
    });
  });

  it("rejects keys that cannot create and delete sandboxes", async () => {
    const qualifier = new DaytonaProviderConnectionQualifier({
      clientFactory: () => ({
        currentApiKey: async () => ({
          permissions: ["write:sandboxes"],
          expiresAt: null,
        }),
      }),
    });

    await expect(qualifier.qualify(input)).rejects.toMatchObject({
      code: "provider_credential_permissions_insufficient",
    });
  });

  it("fails closed without reflecting provider errors or credentials", async () => {
    const qualifier = new DaytonaProviderConnectionQualifier({
      clientFactory: ({ apiKey }) => ({
        currentApiKey: async () => {
          throw new Error(`provider rejected ${apiKey}`);
        },
      }),
    });

    const error = await qualifier.qualify(input).catch((value) => value);
    expect(error).toBeInstanceOf(CloudProviderQualificationError);
    expect(error).toMatchObject({ code: "provider_credential_rejected" });
    expect(String(error)).not.toContain(input.apiKey);
  });
});
