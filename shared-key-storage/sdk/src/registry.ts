/**
 * Key records uploaded in chunks and published by the vault.
 * Publication and user-registry changes run in the same wallet transaction.
 * Replaced records are closed and their rent goes to the vault; the latest
 * record contains all old viewing keys.
 */
import {
  AccountRole,
  type Address,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import type { SprClient } from "@heliuslabs/spr/client";
import { getUserRecordAddress } from "@heliuslabs/spr/addresses";
import { getRegisterInstructionAsync } from "@heliuslabs/spr/instructions";
import { USER_REGISTRY_PROGRAM_ID } from "@heliuslabs/spr/interface";
import type { Bytes33 } from "@heliuslabs/spr/keypair";
import { fetchUserRecord } from "@heliuslabs/spr/wallet";
import { ByteWriter } from "./bytes.js";
import {
  decodeKeyRecord,
  encodeKeyRecord,
  isCurrentKeyRecord,
  type KeyRecord,
} from "./keyRecord.js";
import {
  fetchPublishedRecord,
  prepareRecordUpload,
  type RecordUpload,
} from "./record/storage.js";

const UPDATE_KEYS = 2;

/** The vault's published key record, which the next publication replaces and closes. */
export interface KeyRecordPublication {
  /** The Record account holding the key record. */
  readonly address: Address;
  readonly record: KeyRecord;
}

/** What the registries say about the vault's keys. */
export interface VaultRegistry {
  /** The registered shared viewing public key. */
  readonly viewingPublicKey: Bytes33;
  /** The published key record, if any. */
  readonly current: KeyRecordPublication | undefined;
}

/** The vault's published key record read through its storage pointer, if any. */
export async function fetchPublishedKeyRecord(
  client: SprClient,
  vault: Address,
): Promise<KeyRecordPublication | undefined> {
  const published = await fetchPublishedRecord(client.solanaRpc, vault);
  if (published === undefined) return undefined;
  return {
    address: published.address,
    record: decodeKeyRecord(published.bytes),
  };
}

/** The registered viewing key and current published record, if registered. */
export async function fetchVaultRegistry(
  client: SprClient,
  vault: Address,
): Promise<VaultRegistry | undefined> {
  const userRecord = await fetchUserRecord({ rpc: client, owner: vault });
  if (userRecord === undefined) return undefined;
  return {
    viewingPublicKey: userRecord.viewingPublicKey,
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
 * Prepare upload transactions; send each before submitting register or
 * rotate. `payer` funds the upload and gets the rent back only by sending
 * `closeInstruction` before the upload's last transaction; when a later
 * rotation closes the record, its rent goes to the vault.
 */
export function prepareKeyRecordUpload(
  input: Readonly<{
    owner: Address;
    payer: TransactionSigner;
    record: KeyRecord;
  }>,
): Promise<RecordUpload> {
  return prepareRecordUpload({
    ...input,
    bytes: encodeKeyRecord(input.record),
  });
}

/**
 * Registry `register` of the vault with the record's public keys. The vault
 * owns and pays for the registry record. It fails on chain once the vault is
 * registered.
 */
export function registerVaultKeysInstruction(
  vault: Address,
  record: KeyRecord,
): Promise<Instruction> {
  return getRegisterInstructionAsync({
    owner: vault,
    payer: vault,
    nullifierPublicKey: record.nullifierPublicKey,
    viewingPublicKey: record.sharedViewingPublicKey,
  });
}

/**
 * Registry `update_keys`: replaces the viewing key of `owner`'s record and
 * fails on chain when `owner` has no record.
 */
export async function updateKeysInstruction(
  owner: Address,
  viewingPublicKey: Bytes33,
): Promise<Instruction> {
  return {
    programAddress: USER_REGISTRY_PROGRAM_ID,
    accounts: [
      {
        address: await getUserRecordAddress(owner),
        role: AccountRole.WRITABLE,
      },
      { address: owner, role: AccountRole.READONLY_SIGNER },
    ],
    data: new ByteWriter().u8(UPDATE_KEYS).bytes(viewingPublicKey).finish(),
  };
}
