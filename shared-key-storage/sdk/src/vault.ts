/**
 * The parts of the Create, Register, Rotate and Spend flows that do not
 * depend on which smart wallet owns the vault: key records, their checks, the
 * user registry and the SPP spend. `smart-account/` and `swig/` wrap these
 * in the wallet's own instructions.
 *
 * `accountId` is the wallet account a key record is bound to (the Squads
 * Settings or the Swig account), `vault` the address that signs for it and
 * owns the shielded UTXOs, and `signers` the wallet's members.
 */
import type { Address, Instruction, TransactionSigner } from "@solana/kit";
import {
  ShieldedAddress,
  ViewingKey,
  X25519PublicKey,
  type ShieldedKeypair,
} from "@heliuslabs/spr/keypair";
import { LocalKeys, type SprClient } from "@heliuslabs/spr/client";
import { transactInstruction } from "@heliuslabs/spr/interface";
import {
  AssetRegistry,
  ConfidentialTransfer,
  LocalShieldedKeys,
  ProofInputUtxo,
  encryptConfidentialTransfer,
  type Utxo,
} from "@heliuslabs/spr/transaction";
import { fetchUserRecord } from "@heliuslabs/spr/wallet";

import { bytesEqual } from "./bytes.js";
import {
  buildKeyRecord,
  checkKeyHistory,
  encodeKeyRecord,
  recoverSharedSecrets,
  recoverOldViewingKeys,
  type KeyRecipient,
  type KeyRecord,
  type SharedSecrets,
} from "./keyRecord.js";
import {
  currentKeyRecord,
  fetchPublishedKeyRecord,
  fetchVaultRegistry,
  type KeyRecordPublication,
} from "./registry.js";
import { checkUploadedRecord } from "./record/storage.js";

/** A wallet member: its Solana signer and its shielded keypair. */
export interface Member {
  readonly signer: TransactionSigner;
  readonly keypair: ShieldedKeypair;
}

export function memberFromKeypair(keypair: ShieldedKeypair): Member {
  return { signer: keypair.toSolanaSigner(), keypair };
}

export interface Payment {
  readonly recipient: ShieldedAddress;
  readonly asset: Address;
  readonly amount: bigint;
}

/** The shared secrets and every viewing key of a key record, current first. */
export interface VaultSecrets {
  readonly record: KeyRecord;
  readonly secrets: SharedSecrets;
  readonly viewingKeys: ViewingKey[];
}

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

export function destroySecrets(secrets: SharedSecrets): void {
  secrets.viewingKey.destroy();
  secrets.nullifierKey.destroy();
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

/**
 * Recovers `member`'s shared secrets from `record`, and the viewing keys of
 * every previous epoch, current first. All of these secrets are encrypted
 * into the latest key record, including for newly added signers. Their keys
 * open UTXOs the vault received before a rotate; the SDK's wallet sync tries
 * every viewing key it holds on each of the vault's outputs.
 */
export function recoverRecordKeys(
  record: KeyRecord,
  member: Member,
): VaultSecrets {
  const secrets = recoverSharedSecrets(
    record,
    member.signer.address,
    member.keypair,
  );
  const viewingKeys = [secrets.viewingKey.clone()];
  try {
    viewingKeys.push(
      ...recoverOldViewingKeys(record, secrets.viewingKey).reverse(),
    );
  } catch (error) {
    destroySecrets(secrets);
    viewingKeys.forEach((key) => key.destroy());
    throw error;
  }
  return { record, secrets, viewingKeys };
}

/**
 * Checks a proposed key record against the vault's accounts: the upload at
 * `upload` is frozen under the vault and holds exactly `record`, and `record`
 * extends the vault's published record, read through the vault's storage
 * pointer. Before Register there is none, so `record` must be epoch 0.
 * Returns the published record.
 */
export async function checkProposedKeyRecord(
  input: Readonly<{
    client: SprClient;
    accountId: Address;
    vault: Address;
    record: KeyRecord;
    upload: Address;
  }>,
): Promise<KeyRecordPublication | undefined> {
  const { record } = input;
  if (record.settings !== input.accountId) {
    throw new Error(`the key record belongs to ${record.settings}`);
  }
  await checkUploadedRecord(
    input.client.solanaRpc,
    input.vault,
    input.upload,
    encodeKeyRecord(record),
  );
  const published = await fetchPublishedKeyRecord(input.client, input.vault);
  checkKeyHistory(record, published?.record);
  return published;
}

/**
 * Checks that `member`'s entry in `record` opens to keys matching the record,
 * including every old viewing key.
 */
export function checkEntryOpens(record: KeyRecord, member: Member): void {
  const { secrets, viewingKeys } = recoverRecordKeys(record, member);
  destroySecrets(secrets);
  viewingKeys.forEach((key) => key.destroy());
}

/**
 * Throws unless `proposed` holds exactly the `expected` instructions, in
 * order: the same programs, accounts, account roles and data. Both lists are
 * instructions as built. Instructions decompiled from a transaction message
 * have their account roles merged across the transaction and may not match.
 */
export function checkInstructionsMatch(
  expected: readonly Instruction[],
  proposed: readonly Instruction[],
): void {
  if (expected.length !== proposed.length) {
    throw new Error(
      `expected ${expected.length} instructions, got ${proposed.length}`,
    );
  }
  expected.forEach((instruction, index) => {
    const proposedInstruction = proposed.at(index);
    const accounts = instruction.accounts ?? [];
    const proposedAccounts = proposedInstruction?.accounts ?? [];
    if (
      proposedInstruction === undefined ||
      proposedInstruction.programAddress !== instruction.programAddress ||
      proposedAccounts.length !== accounts.length ||
      accounts.some(
        (account, position) =>
          account.address !== proposedAccounts.at(position)?.address ||
          account.role !== proposedAccounts.at(position)?.role,
      ) ||
      !bytesEqual(
        instruction.data ?? new Uint8Array(),
        proposedInstruction.data ?? new Uint8Array(),
      )
    ) {
      throw new Error(`instruction ${index} is not the expected instruction`);
    }
  });
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
  const record = await fetchUserRecord({ rpc: client, owner: signer });
  if (record === undefined) {
    throw new Error(`kept signer ${signer} is not in the user registry`);
  }
  return X25519PublicKey.fromBytes(record.viewingPublicKey);
}

/**
 * The key record after `record` for `recipients`: `rotator` recovers the
 * current secrets, then a new shared viewing key and the unchanged nullifier
 * secret are encrypted to the recipients, with every old viewing key.
 */
export function rotatedKeyRecord(
  input: Readonly<{
    accountId: Address;
    record: KeyRecord;
    rotator: Member;
    recipients: readonly KeyRecipient[];
  }>,
): KeyRecord {
  const { record } = input;
  const secrets = recoverSharedSecrets(
    record,
    input.rotator.signer.address,
    input.rotator.keypair,
  );
  const newSecrets: SharedSecrets = {
    viewingKey: ViewingKey.generate(),
    nullifierKey: secrets.nullifierKey,
  };
  let previousViewingKeys: ViewingKey[] = [];
  try {
    previousViewingKeys = recoverOldViewingKeys(record, secrets.viewingKey);
    const next = buildKeyRecord({
      settings: input.accountId,
      epoch: record.epoch + 1n,
      secrets: newSecrets,
      previousViewingKeys: [...previousViewingKeys, secrets.viewingKey],
      recipients: input.recipients,
    });
    checkKeyHistory(next, record);
    return next;
  } finally {
    previousViewingKeys.forEach((key) => key.destroy());
    newSecrets.viewingKey.destroy();
    destroySecrets(secrets);
  }
}

/** The key holders for syncing and proving as the vault. */
export function vaultKeys(
  client: SprClient,
  vault: Address,
  secrets: SharedSecrets,
  viewingKeys: readonly ViewingKey[],
): Readonly<{
  address: ShieldedAddress;
  shielded: LocalShieldedKeys;
  proving: LocalKeys;
}> {
  const address = ShieldedAddress.forPda({
    pda: vault,
    nullifierPublicKey: secrets.nullifierKey.publicKey(),
    viewingPublicKey: secrets.viewingKey.publicKey(),
  });
  const keys = { address, viewingKeys, nullifierKey: secrets.nullifierKey };
  const shielded = LocalShieldedKeys.fromKeys(keys);
  try {
    return {
      address,
      shielded,
      proving: LocalKeys.fromKeys(keys, client.proofService),
    };
  } catch (error) {
    shielded.destroy();
    throw error;
  }
}

/**
 * Spend steps 3 and 4: a confidential transfer from the vault's UTXOs, proved
 * with the shared nullifier secret, as the SPP `transact` the wallet runs
 * signed by the vault. The vault is the owner signer and the SPP payer, so it
 * needs SOL for the fees.
 */
export async function vaultTransactInstruction(
  input: Readonly<{
    client: SprClient;
    vault: Address;
    secrets: SharedSecrets;
    viewingKeys: readonly ViewingKey[];
    inputs: readonly Utxo[];
    payments: readonly Payment[];
  }>,
): Promise<Instruction> {
  const { vault } = input;
  const assets = new AssetRegistry();
  const keys = vaultKeys(input.client, vault, input.secrets, input.viewingKeys);
  try {
    const proofInputs = input.inputs.map((utxo) =>
      ProofInputUtxo.fromNullifierKey(utxo, input.secrets.nullifierKey),
    );
    const transfer = new ConfidentialTransfer(keys.address, proofInputs, vault);
    for (const payment of input.payments) {
      transfer.send(payment.recipient, payment.asset, payment.amount);
    }
    const prepared = transfer.prepare();
    const [txKey] = await keys.shielded.transactionKeys([
      {
        viewingPublicKey: keys.address.viewingPublicKey,
        firstNullifier: prepared.firstNullifier,
      },
    ]);
    if (txKey === undefined)
      throw new Error("no transaction key for the transfer");
    let encrypted: ReturnType<typeof encryptConfidentialTransfer>;
    try {
      encrypted = encryptConfidentialTransfer(txKey, {
        outputs: prepared.outputs,
        assets,
      });
    } finally {
      txKey.destroy();
    }
    const sppProofInputs = prepared.finalize({
      txViewingPublicKey: encrypted.txViewingPublicKey,
      salt: encrypted.salt,
      payload: encrypted.payload,
    });
    const data = await input.client.proveTransact(sppProofInputs, keys.proving);
    return transactInstruction({
      payer: vault,
      ownerSigners: [vault],
      inputTree: input.client.tree,
      outputTree: input.client.tree,
      data,
    });
  } finally {
    keys.shielded.destroy();
    keys.proving.destroy();
  }
}
