import {
  constants,
  createHash,
  generateKeyPairSync,
  privateEncrypt,
  sign,
  type KeyObject,
} from "node:crypto";
import { createRequire } from "node:module";

import { beforeAll, describe, expect, it } from "vitest";

interface ForgePublicKey {
  verify(digest: string, signature: string): boolean;
}

interface ForgeModule {
  pki: { publicKeyFromPem(pem: string): ForgePublicKey };
}

const rootRequire = createRequire(import.meta.url);
const sandboxRequire = createRequire(
  rootRequire.resolve("@anthropic-ai/sandbox-runtime"),
);
const forge = sandboxRequire("node-forge") as ForgeModule;
const message = Buffer.from("installed sandbox RSA verification regression");
const digest = createHash("sha256").update(message).digest();
const sha256Oid = Buffer.from("0609608648016503040201", "hex");
const nullParameters = Buffer.from([0x05, 0x00]);
const extraOctetString = Buffer.from([0x04, 0x03, 0x61, 0x62, 0x63]);

function sequence(elements: Buffer[]): Buffer {
  const contents = Buffer.concat(elements);
  if (contents.length >= 128)
    throw new Error("Fixture exceeds short DER length");
  return Buffer.concat([Buffer.from([0x30, contents.length]), contents]);
}

describe.each([3, 65537])(
  "installed sandbox-runtime Forge verifier with RSA exponent %i",
  (publicExponent) => {
    let privateKey: KeyObject;
    let publicKey: ForgePublicKey;

    beforeAll(() => {
      const keyPair = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        publicExponent,
      });
      privateKey = keyPair.privateKey;
      publicKey = forge.pki.publicKeyFromPem(
        keyPair.publicKey.export({ type: "spki", format: "pem" }).toString(),
      );
    });

    function digestInfoSignature(
      algorithmElements: Buffer[],
      outerElements: Buffer[] = [],
      suffix: Buffer = Buffer.alloc(0),
    ): string {
      const digestInfo = sequence([
        sequence(algorithmElements),
        Buffer.concat([Buffer.from([0x04, digest.length]), digest]),
        ...outerElements,
      ]);
      return privateEncrypt(
        { key: privateKey, padding: constants.RSA_PKCS1_PADDING },
        Buffer.concat([digestInfo, suffix]),
      ).toString("binary");
    }

    it.each(["sha1", "sha224", "sha256", "sha384", "sha512", "md5"])(
      "accepts a valid native %s PKCS#1 v1.5 signature",
      (algorithm) => {
        const signature = sign(algorithm, message, privateKey);
        expect(
          publicKey.verify(
            createHash(algorithm).update(message).digest().toString("binary"),
            signature.toString("binary"),
          ),
        ).toBe(true);
      },
    );

    it("accepts SHA-256 DigestAlgorithm with omitted optional NULL", () => {
      expect(
        publicKey.verify(
          digest.toString("binary"),
          digestInfoSignature([sha256Oid]),
        ),
      ).toBe(true);
    });

    it("rejects an otherwise valid signature for a different message", () => {
      expect(
        publicKey.verify(
          createHash("sha256").update("different message").digest("binary"),
          sign("sha256", message, privateKey).toString("binary"),
        ),
      ).toBe(false);
    });

    it.each([
      [
        "extra OCTET STRING after NULL",
        [sha256Oid, nullParameters, extraOctetString],
      ],
      ["extra OCTET STRING without NULL", [sha256Oid, extraOctetString]],
      ["duplicate NULL", [sha256Oid, nullParameters, nullParameters]],
      [
        "extra nested SEQUENCE",
        [sha256Oid, nullParameters, sequence([extraOctetString])],
      ],
    ] as const)(
      "rejects DigestAlgorithm with %s",
      (_name, algorithmElements) => {
        const signature = digestInfoSignature([...algorithmElements]);
        expect(() =>
          publicKey.verify(digest.toString("binary"), signature),
        ).toThrow(/does not contain a valid RSASSA-PKCS1-v1_5 DigestInfo/);
      },
    );

    it("still rejects extra outer DigestInfo elements", () => {
      const signature = digestInfoSignature(
        [sha256Oid, nullParameters],
        [extraOctetString],
      );
      expect(() =>
        publicKey.verify(digest.toString("binary"), signature),
      ).toThrow(/does not contain a valid RSASSA-PKCS1-v1_5 DigestInfo/);
    });

    it("still rejects trailing bytes outside DigestInfo", () => {
      const signature = digestInfoSignature(
        [sha256Oid, nullParameters],
        [],
        extraOctetString,
      );
      expect(() =>
        publicKey.verify(digest.toString("binary"), signature),
      ).toThrow();
    });
  },
);
