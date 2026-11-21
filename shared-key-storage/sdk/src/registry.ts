/**
 * The SPP user registry: a vault registers its shared viewing and nullifier
 * public keys there, and a rotation replaces the viewing key. Signers'
 * viewing keys are read from it too.
 */
import { AccountRole, type Address, type Instruction } from "@solana/kit";
import type { SprClient } from "@heliuslabs/spr/client";
import { getUserRecordAddress } from "@heliuslabs/spr/addresses";
import { getRegisterInstructionAsync } from "@heliuslabs/spr/instructions";
import { USER_REGISTRY_PROGRAM_ID } from "@heliuslabs/spr/interface";
import { X25519PublicKey, type Bytes33 } from "@heliuslabs/spr/keypair";
import { fetchUserRecord } from "@heliuslabs/spr/wallet";
import { ByteWriter } from "./bytes.js";
import type { KeyRecord } from "./keyRecord.js";

const UPDATE_KEYS = 2;

/** The viewing public key `owner` registered, if it is registered. */
export async function fetchRegisteredViewingKey(
  client: SprClient,
  owner: Address,
): Promise<Bytes33 | undefined> {
  const userRecord = await fetchUserRecord({ rpc: client, owner });
  return userRecord?.viewingPublicKey;
}

/**
 * A kept signer's viewing public key, read from its user registry record.
 * Taking it from anywhere the rotator controls would let the rotator choose
 * whom the new shared viewing key is encrypted to.
 */
export async function registeredViewingKey(
  client: SprClient,
  signer: Address,
): Promise<X25519PublicKey> {
  const viewingPublicKey = await fetchRegisteredViewingKey(client, signer);
  if (viewingPublicKey === undefined) {
    throw new Error(`kept signer ${signer} is not in the user registry`);
  }
  return X25519PublicKey.fromBytes(viewingPublicKey);
}

/** `entries`, each with its key's registered viewing key added. */
export function withRegisteredViewingKeys<T extends { readonly key: Address }>(
  client: SprClient,
  entries: readonly T[],
): Promise<(T & { readonly viewingPublicKey: X25519PublicKey })[]> {
  return Promise.all(
    entries.map(async (entry) => ({
      ...entry,
      viewingPublicKey: await registeredViewingKey(client, entry.key),
    })),
  );
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
