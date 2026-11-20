/**
 * Encryption of key record secrets. Encrypting `plaintext` to recipient public
 * key `R` under ephemeral secret `e` (public key `E`):
 *
 *   dh  = X25519(e, R)
 *   key = HKDF-SHA256(ikm = dh, salt = E || R, info) -> 32 bytes
 *   ct  = AES-256-CTR(key, iv = 0^16, plaintext)
 *
 * The HKDF info separates the signer, nullifier and indexed historical-key
 * domains, so the zero IV never repeats under a derived key.
 */
import { createCipheriv, hkdfSync } from "node:crypto";

import {
  X25519Keypair,
  X25519PublicKey,
  type Bytes33,
} from "@heliuslabs/spr/keypair";

import { ByteWriter } from "./bytes.js";

const utf8 = new TextEncoder();
/** Info for the shared viewing secret, encrypted to each signer. */
export const KEY_INFO = utf8.encode("zolana-examples/smart-account-client/key");
/** Info for the nullifier secret, encrypted to the shared viewing key. */
export const NULLIFIER_INFO = utf8.encode(
  "zolana-examples/smart-account-client/nullifier",
);
const OLD_KEY_INFO = utf8.encode(
  "zolana-examples/smart-account-client/old-key",
);

/** Info for historical viewing secret `index`: `OLD_KEY_INFO || LE32(index)`. */
export function oldKeyInfo(index: number): Uint8Array {
  return new ByteWriter().bytes(OLD_KEY_INFO).u32(index).finish();
}

/** A recipient's view of its own X25519 key: an ECDH and its public key. */
export interface SignerViewingKey {
  publicKey(): X25519PublicKey;
  ecdh(counterparty: X25519PublicKey): Uint8Array;
}

function streamKey(
  dh: Uint8Array,
  ephemeralPublicKey: Uint8Array,
  recipientPublicKey: Uint8Array,
  info: Uint8Array,
): Buffer {
  const salt = new Uint8Array(
    ephemeralPublicKey.length + recipientPublicKey.length,
  );
  salt.set(ephemeralPublicKey, 0);
  salt.set(recipientPublicKey, ephemeralPublicKey.length);
  return Buffer.from(hkdfSync("sha256", dh, salt, info, 32));
}

/**
 * AES-256-CTR with a zero IV; encryption and decryption are the same. Zeroes
 * the key and the intermediate buffers; the caller owns the returned copy.
 */
function ctrApply(key: Buffer, data: Uint8Array): Uint8Array {
  const cipher = createCipheriv("aes-256-ctr", key, Buffer.alloc(16));
  const parts = [cipher.update(data), cipher.final()];
  const joined = Buffer.concat(parts);
  try {
    return new Uint8Array(joined);
  } finally {
    key.fill(0);
    joined.fill(0);
    parts.forEach((part) => part.fill(0));
  }
}

/** Encrypts `plaintext` to `recipient` under `ephemeral` in domain `info`. */
export function encryptTo(
  ephemeral: X25519Keypair,
  recipient: X25519PublicKey,
  plaintext: Uint8Array,
  info: Uint8Array,
): Uint8Array {
  const dh = ephemeral.ecdh(recipient);
  try {
    return ctrApply(
      streamKey(dh, ephemeral.publicKey().toBytes(), recipient.toBytes(), info),
      plaintext,
    );
  } finally {
    dh.fill(0);
  }
}

/**
 * Decrypts `ciphertext` sent to `key` under the ephemeral public key in
 * domain `info`. CTR has no authentication: the caller checks the plaintext
 * against the public key it should belong to.
 */
export function decryptWith(
  key: SignerViewingKey,
  ephemeralPublicKey: Bytes33,
  ciphertext: Uint8Array,
  info: Uint8Array,
): Uint8Array {
  const dh = key.ecdh(X25519PublicKey.fromBytes(ephemeralPublicKey));
  try {
    return ctrApply(
      streamKey(dh, ephemeralPublicKey, key.publicKey().toBytes(), info),
      ciphertext,
    );
  } finally {
    dh.fill(0);
  }
}
