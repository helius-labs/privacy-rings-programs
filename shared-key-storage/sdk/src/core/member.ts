/** A wallet member and the vault secrets it recovers from a key record. */
import type { TransactionSigner } from "@solana/kit";
import type { ShieldedKeypair, ViewingKey } from "@heliuslabs/spr/keypair";

import type { KeyRecord, SharedSecrets } from "../keyRecord.js";

/** A wallet member: its Solana signer and its shielded keypair. */
export interface Member {
  readonly signer: TransactionSigner;
  readonly keypair: ShieldedKeypair;
}

export function memberFromKeypair(keypair: ShieldedKeypair): Member {
  return { signer: keypair.toSolanaSigner(), keypair };
}

/** The shared secrets and every viewing key of a key record, current first. */
export interface VaultSecrets {
  readonly record: KeyRecord;
  readonly secrets: SharedSecrets;
  readonly viewingKeys: ViewingKey[];
}

export function destroySecrets(secrets: SharedSecrets): void {
  secrets.viewingKey.destroy();
  secrets.nullifierKey.destroy();
}

/** Destroys the shared secrets and every viewing key of `vault`. */
export function destroyVaultSecrets(
  vault: Pick<VaultSecrets, "secrets" | "viewingKeys">,
): void {
  destroySecrets(vault.secrets);
  vault.viewingKeys.forEach((key) => key.destroy());
}
