/**
 * The key record encryption: pinned to the documented construction, computed
 * here independently with Node's crypto, so a change to the format fails even
 * though encryption and decryption would still agree with each other.
 */
import assert from "node:assert/strict";
import { createCipheriv, hkdfSync, randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { X25519Keypair } from "@heliuslabs/spr/keypair";

import {
  KEY_INFO,
  NULLIFIER_INFO,
  decryptWith,
  encryptTo,
  oldKeyInfo,
} from "../src/encryption.js";

/** AES-256-CTR(HKDF-SHA256(X25519(e, R), E || R, info), iv = 0, plaintext). */
function documented(
  ephemeral: X25519Keypair,
  recipient: X25519Keypair,
  plaintext: Uint8Array,
  info: Uint8Array,
): Uint8Array {
  const dh = ephemeral.ecdh(recipient.publicKey());
  const salt = Buffer.concat([
    ephemeral.publicKey().toBytes(),
    recipient.publicKey().toBytes(),
  ]);
  const key = Buffer.from(hkdfSync("sha256", dh, salt, info, 32));
  const cipher = createCipheriv("aes-256-ctr", key, Buffer.alloc(16));
  return new Uint8Array(
    Buffer.concat([cipher.update(plaintext), cipher.final()]),
  );
}

describe("key record encryption", () => {
  const ephemeral = X25519Keypair.generate();
  const recipient = X25519Keypair.generate();
  const plaintext = Uint8Array.from(randomBytes(32));

  it("matches the documented construction and round-trips", () => {
    for (const info of [KEY_INFO, NULLIFIER_INFO, oldKeyInfo(0)]) {
      const ciphertext = encryptTo(
        ephemeral,
        recipient.publicKey(),
        plaintext,
        info,
      );
      assert.deepEqual(
        ciphertext,
        documented(ephemeral, recipient, plaintext, info),
      );
      assert.deepEqual(
        decryptWith(
          recipient,
          ephemeral.publicKey().toBytes(),
          ciphertext,
          info,
        ),
        plaintext,
      );
    }
  });

  it("separates every domain, including each historical index", () => {
    const infos = [
      KEY_INFO,
      NULLIFIER_INFO,
      oldKeyInfo(0),
      oldKeyInfo(1),
      oldKeyInfo(256),
    ];
    const ciphertexts = infos.map((info) =>
      Buffer.from(
        encryptTo(ephemeral, recipient.publicKey(), plaintext, info),
      ).toString("hex"),
    );
    assert.equal(new Set(ciphertexts).size, infos.length);
    // Decrypting in the wrong domain does not give the plaintext back.
    const ciphertext = encryptTo(
      ephemeral,
      recipient.publicKey(),
      plaintext,
      KEY_INFO,
    );
    assert.notDeepEqual(
      decryptWith(
        recipient,
        ephemeral.publicKey().toBytes(),
        ciphertext,
        NULLIFIER_INFO,
      ),
      plaintext,
    );
  });

  it("appends the historical index as a little-endian u32", () => {
    const prefix = new TextEncoder().encode(
      "zolana-examples/smart-account-client/old-key",
    );
    assert.deepEqual(
      oldKeyInfo(0x01020304),
      Uint8Array.of(...prefix, 0x04, 0x03, 0x02, 0x01),
    );
  });

  it("does not decrypt for another recipient", () => {
    const ciphertext = encryptTo(
      ephemeral,
      recipient.publicKey(),
      plaintext,
      KEY_INFO,
    );
    assert.notDeepEqual(
      decryptWith(
        X25519Keypair.generate(),
        ephemeral.publicKey().toBytes(),
        ciphertext,
        KEY_INFO,
      ),
      plaintext,
    );
  });
});
