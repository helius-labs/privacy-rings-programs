/**
 * What the wallet-agnostic actions read from chain: account data and the
 * vault's current key record. `smart-account/` and `swig/` wrap the actions
 * in `core/` in the wallet's own instructions.
 *
 * `accountId` is the wallet account a key record is bound to (the Squads
 * Settings or the Swig account), `vault` the address that signs for it and
 * owns the shielded UTXOs, and `signers` the wallet's members.
 */
import type { Address } from "@solana/kit";
import type { Bytes33 } from "@heliuslabs/spr/keypair";
import type { SprClient } from "@heliuslabs/spr/client";

import { isCurrentKeyRecord } from "../keyRecord.js";
import { fetchRegisteredViewingKey } from "../registry.js";
import {
  fetchPublishedKeyRecord,
  type KeyRecordPublication,
} from "../record/keyRecordStorage.js";

export async function accountData(
  client: SprClient,
  account: Address,
): Promise<Uint8Array | undefined> {
  const { value } = await client.solanaRpc
    .getAccountInfo(account, { encoding: "base64", commitment: "confirmed" })
    .send();
  if (value === null) return undefined;
  return new Uint8Array(Buffer.from(value.data[0], "base64"));
}

/** What the user registry and the storage pointer say about the vault's keys. */
export interface VaultRegistry {
  /** The registered shared viewing public key. */
  readonly viewingPublicKey: Bytes33;
  /** The published key record, if any. */
  readonly current: KeyRecordPublication | undefined;
}

/** The registered viewing key and current published record, if registered. */
export async function fetchVaultRegistry(
  client: SprClient,
  vault: Address,
): Promise<VaultRegistry | undefined> {
  const viewingPublicKey = await fetchRegisteredViewingKey(client, vault);
  if (viewingPublicKey === undefined) return undefined;
  return {
    viewingPublicKey,
    current: await fetchPublishedKeyRecord(client, vault),
  };
}

/**
 * The current key record: the one the vault's storage pointer names. It
 * must belong to `settings`, name exactly the wallet's signers, and hold the
 * registered viewing key; a wallet transaction that changed the signers
 * outside the rotate flow breaks the last two.
 */
export function currentKeyRecord(
  registry: VaultRegistry,
  settings: Address,
  signers: readonly Address[],
): KeyRecordPublication {
  const { current } = registry;
  if (current === undefined) {
    throw new Error(`the vault of ${settings} has no key record`);
  }
  if (
    !isCurrentKeyRecord(current.record, {
      settings,
      signers,
      registeredViewingPublicKey: registry.viewingPublicKey,
    })
  ) {
    throw new Error(
      `the key record of ${settings} does not match its signers and registered key`,
    );
  }
  return current;
}

/**
 * The current key record of a registered vault. It must be bound to
 * `accountId`, name exactly `signers` and hold the registered viewing key.
 */
export async function fetchCurrentKeyRecord(
  client: SprClient,
  accountId: Address,
  vault: Address,
  signers: readonly Address[],
): Promise<KeyRecordPublication> {
  const registry = await fetchVaultRegistry(client, vault);
  if (registry === undefined) {
    throw new Error(`the vault of ${accountId} is not registered`);
  }
  return currentKeyRecord(registry, accountId, signers);
}
