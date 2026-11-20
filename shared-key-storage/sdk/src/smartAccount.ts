/**
 * The Create, Register, Rotate and Spend flows of design.md, as instruction
 * builders. The vault (Squads smart account at index 0) owns the shielded
 * UTXOs; Squads signs for it in `executeTransactionSyncV2`. The current key
 * record is published through the vault's storage pointer and contains all old
 * viewing keys. Replaced record accounts are closed and their rent goes to the
 * vault. No proof checks a key record.
 */
import {
  createNoopSigner,
  type Address,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
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
  compareAddresses,
  encodeKeyRecord,
  generateNullifierKey,
  isCurrentKeyRecord,
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
  registerVaultKeysInstruction,
  prepareKeyRecordUpload,
  updateKeysInstruction,
  type KeyRecordPublication,
} from "./registry.js";
import {
  checkUploadedRecord,
  publishRecordInstructions,
  type RecordUpload,
} from "./storage.js";
import {
  checkSyncConsensus,
  createSmartAccountInstruction,
  decodeProgramConfig,
  decodeSettings,
  executeSettingsTransactionSyncInstruction,
  executeTransactionSyncInstruction,
  programConfigAddress,
  rotationActions,
  settingsAddress,
  vaultAddress,
  type Settings,
  type SmartAccountSigner,
} from "./squads.js";

/** A signer to add: its Squads permissions and its viewing public key. */
export interface NewSigner extends SmartAccountSigner, KeyRecipient {}

/** A smart account member: its Solana signer and its shielded keypair. */
export interface Member {
  readonly signer: TransactionSigner;
  readonly keypair: ShieldedKeypair;
}

export function memberFromKeypair(keypair: ShieldedKeypair): Member {
  return { signer: keypair.toSolanaSigner(), keypair };
}

async function accountData(
  client: SprClient,
  account: Address,
): Promise<Uint8Array | undefined> {
  const { value } = await client.solanaRpc
    .getAccountInfo(account, { encoding: "base64", commitment: "confirmed" })
    .send();
  if (value === null) return undefined;
  return new Uint8Array(Buffer.from(value.data[0], "base64"));
}

export async function fetchSettings(
  client: SprClient,
  settings: Address,
): Promise<Settings> {
  const data = await accountData(client, settings);
  if (data === undefined)
    throw new Error(`Squads Settings ${settings} does not exist`);
  return decodeSettings(data);
}

/** The vault's shielded identity under the shared keys. */
function vaultShieldedAddress(
  vault: Address,
  secrets: SharedSecrets,
): ShieldedAddress {
  return ShieldedAddress.forPda({
    pda: vault,
    nullifierPublicKey: secrets.nullifierKey.publicKey(),
    viewingPublicKey: secrets.viewingKey.publicKey(),
  });
}

/**
 * The current key record of a registered vault, read with the Squads
 * signers in one place so both come from the same reads.
 */
async function fetchCurrentKeyRecord(
  client: SprClient,
  settings: Address,
  decoded: Settings,
): Promise<KeyRecordPublication> {
  const registry = await fetchVaultRegistry(
    client,
    await vaultAddress(settings),
  );
  if (registry === undefined) {
    throw new Error(`the vault of ${settings} is not registered`);
  }
  return currentKeyRecord(
    registry,
    settings,
    decoded.signers.map((signer) => signer.key),
  );
}

/**
 * Recovers the shared secrets of the current key record, and the viewing
 * keys of every previous epoch, current first. All of these secrets are
 * encrypted into the latest key record, including for newly added signers.
 * Their keys open UTXOs the vault received before a rotate; the SDK's wallet
 * sync tries every viewing key it holds on each of the vault's outputs.
 */
export async function recoverVaultKeys(
  input: Readonly<{
    client: SprClient;
    settings: Address;
    member: Member;
  }>,
): Promise<
  Readonly<{
    record: KeyRecord;
    secrets: SharedSecrets;
    viewingKeys: ViewingKey[];
  }>
> {
  const { record } = await fetchCurrentKeyRecord(
    input.client,
    input.settings,
    await fetchSettings(input.client, input.settings),
  );
  const secrets = recoverSharedSecrets(
    record,
    input.member.signer.address,
    input.member.keypair,
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

function destroySecrets(secrets: SharedSecrets): void {
  secrets.viewingKey.destroy();
  secrets.nullifierKey.destroy();
}

/**
 * Checks a proposed key record against the vault's accounts: the upload at
 * `upload` is frozen under the vault and holds exactly `record`, and `record`
 * extends the vault's published record, read through the vault's storage
 * pointer. Before Register there is none, so `record` must be epoch 0.
 * Returns the published record.
 */
async function checkProposedKeyRecord(
  input: Readonly<{
    client: SprClient;
    settings: Address;
    record: KeyRecord;
    upload: Address;
  }>,
): Promise<KeyRecordPublication | undefined> {
  const { record } = input;
  if (record.settings !== input.settings) {
    throw new Error(`the key record belongs to ${record.settings}`);
  }
  const vault = await vaultAddress(input.settings);
  await checkUploadedRecord(
    input.client.solanaRpc,
    vault,
    input.upload,
    encodeKeyRecord(record),
  );
  const published = await fetchPublishedKeyRecord(input.client, vault);
  checkKeyHistory(record, published?.record);
  return published;
}

/**
 * Checks that `member`'s entry in `record` opens to keys matching the record,
 * including every old viewing key.
 */
function checkEntryOpens(record: KeyRecord, member: Member): void {
  const secrets = recoverSharedSecrets(
    record,
    member.signer.address,
    member.keypair,
  );
  try {
    recoverOldViewingKeys(record, secrets.viewingKey).forEach((key) =>
      key.destroy(),
    );
  } finally {
    destroySecrets(secrets);
  }
}

/**
 * For an approver that stays or becomes a signer, before it co-signs a
 * Register or Rotate: checks that the upload at `upload` is frozen under the
 * vault and holds exactly `record`, and that its own entry in the record
 * opens to keys matching the record, including every old viewing key. The
 * previous record comes from the vault's storage pointer, the same record the
 * publication closes, never from the rotator. Before Register there is none,
 * so `record` must be epoch 0. Throws on a mismatched upload, a bad
 * ciphertext, a missing key or a broken history.
 *
 * This checks the record, not the transaction that publishes it; use
 * `checkRegistration` or `checkRotation` to check both.
 */
export async function checkOwnEntry(
  input: Readonly<{
    client: SprClient;
    settings: Address;
    record: KeyRecord;
    upload: Address;
    member: Member;
  }>,
): Promise<void> {
  await checkProposedKeyRecord(input);
  checkEntryOpens(input.record, input.member);
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
 * For an approver, before it co-signs a Register: runs `checkOwnEntry`, then
 * builds the Register instruction itself and checks that `proposed` is
 * exactly that. `proposed` must hold every instruction of the transaction the
 * approver signs, as the proposer built them; an instruction left out is not
 * checked.
 */
export async function checkRegistration(
  input: Readonly<{
    client: SprClient;
    settings: Address;
    record: KeyRecord;
    upload: Address;
    member: Member;
    approvers: readonly Address[];
    proposed: readonly Instruction[];
  }>,
): Promise<void> {
  await checkOwnEntry(input);
  checkInstructionsMatch(
    [
      await registerVaultInstruction({
        client: input.client,
        settings: input.settings,
        approvers: input.approvers.map((approver) =>
          createNoopSigner(approver),
        ),
        record: input.record,
        upload: input.upload,
      }),
    ],
    input.proposed,
  );
}

/**
 * For an approver, before it co-signs a Rotate: checks the proposed record
 * and upload as `checkOwnEntry` does, then builds the Rotate instructions
 * itself and checks that `proposed` is exactly those. That covers what the
 * record check cannot see: the hash written to the pointer, the record that
 * is closed, where its rent goes, the new signers' permissions and the
 * threshold.
 *
 * The approver states the rotation it agrees to, as `rotateSmartAccount`
 * takes it: `keep` lists the current signers that stay, with their current
 * permissions, `add` lists the new signers with their permissions, and
 * `threshold` is the new threshold. The record must name exactly those
 * signers, so a rotation that drops or adds anyone else is rejected. An
 * approver that stays or is added must also open its own entry; one the
 * rotation removes has none.
 *
 * `proposed` must hold every instruction of the transaction the approver
 * signs, as the rotator built them; an instruction left out is not checked.
 */
export async function checkRotation(
  input: Readonly<{
    client: SprClient;
    settings: Address;
    record: KeyRecord;
    upload: Address;
    member: Member;
    approvers: readonly Address[];
    rentPayer: Address;
    keep: readonly Address[];
    add: readonly SmartAccountSigner[];
    threshold: number;
    proposed: readonly Instruction[];
  }>,
): Promise<void> {
  const { record, member } = input;
  const current = await fetchSettings(input.client, input.settings);
  checkSyncConsensus(current, input.approvers);
  const published = await checkProposedKeyRecord(input);
  if (published === undefined) {
    throw new Error(`the vault of ${input.settings} has no key record`);
  }
  for (const signer of input.add) {
    if (current.signers.some((entry) => entry.key === signer.key)) {
      throw new Error(`${signer.key} is already a signer; list it in keep`);
    }
  }
  const kept = input.keep.map((key) => {
    const signer = current.signers.find((entry) => entry.key === key);
    if (signer === undefined) throw new Error(`${key} is not a current signer`);
    return signer;
  });
  const next = [...kept, ...input.add];
  // Throws unless the record names exactly the `next` signers.
  const expected = await rotateSmartAccountInstructions({
    settings: input.settings,
    current,
    approvers: input.approvers.map((approver) => createNoopSigner(approver)),
    rentPayer: createNoopSigner(input.rentPayer),
    record,
    upload: input.upload,
    predecessor: published.address,
    next,
    threshold: input.threshold,
  });
  if (next.some((signer) => signer.key === member.signer.address)) {
    checkEntryOpens(record, member);
  }
  checkInstructionsMatch(expected, input.proposed);
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
  const address = vaultShieldedAddress(vault, secrets);
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

// ---------------------------------------------------------------------------
// 1. Create
// ---------------------------------------------------------------------------

export interface CreatedAccount {
  readonly settings: Address;
  readonly vault: Address;
  /** Record 0; Register writes it on chain. */
  readonly record: KeyRecord;
  /** The `createSmartAccount` instruction; the creator signs it. */
  readonly instruction: Instruction;
}

/**
 * Create steps 3 and 4: generates the shared secrets and key record 0, and
 * returns the `createSmartAccount` instruction. The creator sends the
 * instruction and hands `record` to the other signers for Register.
 *
 * The Settings address comes from the Squads account counter, so another
 * account created in between makes the instruction fail; build again then.
 */
export async function createSmartAccount(
  input: Readonly<{
    client: SprClient;
    creator: TransactionSigner;
    signers: readonly NewSigner[];
    threshold: number;
  }>,
): Promise<CreatedAccount> {
  const configData = await accountData(
    input.client,
    await programConfigAddress(),
  );
  if (configData === undefined)
    throw new Error("the Squads ProgramConfig account is missing");
  const config = decodeProgramConfig(configData);
  const settings = await settingsAddress(config.smartAccountIndex + 1n);
  const vault = await vaultAddress(settings);

  const secrets: SharedSecrets = {
    viewingKey: ViewingKey.generate(),
    nullifierKey: generateNullifierKey(),
  };
  try {
    const record = buildKeyRecord({
      settings,
      epoch: 0n,
      secrets,
      previousViewingKeys: [],
      recipients: input.signers,
    });
    const instruction = await createSmartAccountInstruction({
      creator: input.creator,
      treasury: config.treasury,
      settings,
      signers: sortedSigners(input.signers),
      threshold: input.threshold,
    });
    return { settings, vault, record, instruction };
  } finally {
    destroySecrets(secrets);
  }
}

/** `signers` as Squads stores them: key and permissions, sorted by key. */
function sortedSigners(
  signers: readonly SmartAccountSigner[],
): SmartAccountSigner[] {
  return signers
    .map(({ key, permissions }) => ({ key, permissions }))
    .sort((a, b) => compareAddresses(a.key, b.key));
}

// ---------------------------------------------------------------------------
// Create step 6. Register
// ---------------------------------------------------------------------------

/**
 * Squads `executeTransactionSyncV2` with an inner user registry `register`
 * of the record's public keys and the first publication of its upload,
 * both signed by the vault. The vault pays the rent of its user registry
 * record and storage pointer, so it needs SOL; the upload's payer funded the
 * record at `upload`. Each approver runs `checkRegistration` first. `register`
 * fails on chain once the vault is registered, so a second Register cannot
 * replace the keys.
 */
export async function registerVaultInstruction(
  input: Readonly<{
    client: SprClient;
    settings: Address;
    approvers: readonly TransactionSigner[];
    record: KeyRecord;
    upload: Address;
  }>,
): Promise<Instruction> {
  const decoded = await checkApprovers(
    input.client,
    input.settings,
    input.approvers,
  );
  if (input.record.epoch !== 0n) {
    throw new Error(`Register writes record 0, not ${input.record.epoch}`);
  }
  if (
    !isCurrentKeyRecord(input.record, {
      settings: input.settings,
      signers: decoded.signers.map((signer) => signer.key),
      registeredViewingPublicKey: input.record.sharedViewingPublicKey,
    })
  ) {
    throw new Error("the key record does not name the Squads signers");
  }
  const vault = await vaultAddress(input.settings);
  return executeTransactionSyncInstruction({
    settings: input.settings,
    approvers: input.approvers,
    inner: [
      await registerVaultKeysInstruction(vault, input.record),
      ...(await publishRecordInstructions({
        owner: vault,
        upload: input.upload,
        predecessor: undefined,
        bytes: encodeKeyRecord(input.record),
      })),
    ],
  });
}

async function checkApprovers(
  client: SprClient,
  settings: Address,
  approvers: readonly TransactionSigner[],
): Promise<Settings> {
  const decoded = await fetchSettings(client, settings);
  checkSyncConsensus(
    decoded,
    approvers.map((approver) => approver.address),
  );
  return decoded;
}

// ---------------------------------------------------------------------------
// 2. Rotate
// ---------------------------------------------------------------------------

export interface Rotation {
  readonly record: KeyRecord;
  /** Send these upload transactions before the final atomic transaction. */
  readonly upload: RecordUpload;
  /**
   * In order: the user registry `update_keys` and the publication of the
   * uploaded record, which closes the previous record, then the settings
   * change, if any.
   */
  readonly instructions: readonly Instruction[];
}

/**
 * A kept signer's viewing public key, read from its user registry record.
 * Taking it from anywhere the rotator controls would let the rotator choose
 * whom the new shared viewing key is encrypted to.
 */
async function registeredViewingKey(
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
 * The Rotate instructions of step 5, in order: Squads
 * `executeTransactionSyncV2` with the user registry `update_keys` and the
 * publication of the record at `upload`, which closes `predecessor`, then
 * Squads `executeSettingsTransactionSync` moving `current` to the `next`
 * signers and `threshold`, if that changes anything.
 *
 * They depend only on the input, so the rotator and every approver build the
 * same instructions. `next` must name exactly the record's signers.
 */
export async function rotateSmartAccountInstructions(
  input: Readonly<{
    settings: Address;
    /** The decoded Squads Settings account before the rotation. */
    current: Settings;
    approvers: readonly TransactionSigner[];
    /** Pays the Settings reallocation when the signer list grows. */
    rentPayer: TransactionSigner;
    record: KeyRecord;
    /** The Record account holding `record`, frozen under the vault. */
    upload: Address;
    /** The Record account of the key record this rotation replaces. */
    predecessor: Address;
    next: readonly SmartAccountSigner[];
    threshold: number;
  }>,
): Promise<Instruction[]> {
  const { record } = input;
  const next = sortedSigners(input.next);
  const recordSigners = record.entries
    .map((entry) => entry.signer)
    .sort(compareAddresses);
  if (
    next.length !== recordSigners.length ||
    next.some((signer, index) => signer.key !== recordSigners.at(index))
  ) {
    throw new Error("the new signers are not the key record's signers");
  }
  const vault = await vaultAddress(input.settings);
  const instructions: Instruction[] = [
    await executeTransactionSyncInstruction({
      settings: input.settings,
      approvers: input.approvers,
      inner: [
        await updateKeysInstruction(vault, record.sharedViewingPublicKey),
        ...(await publishRecordInstructions({
          owner: vault,
          upload: input.upload,
          predecessor: input.predecessor,
          bytes: encodeKeyRecord(record),
        })),
      ],
    }),
  ];
  const actions = rotationActions(input.current, next, input.threshold);
  // A key-only rotate changes no settings; Squads rejects an empty list.
  if (actions.length > 0) {
    instructions.push(
      executeSettingsTransactionSyncInstruction({
        settings: input.settings,
        rentPayer: input.rentPayer,
        approvers: input.approvers,
        actions,
      }),
    );
  }
  return instructions;
}

/**
 * Rotate steps 2 to 5 for a registered vault: recovers the current secrets,
 * encrypts a new shared viewing key and the unchanged nullifier secret to
 * the new signer set, and returns the new record and the rotate
 * instructions. `keep` lists the current signers that stay, whose viewing
 * keys come from the user registry; `add` lists new signers with their
 * viewing keys. `payer` funds the upload; when a later rotate closes this
 * record, its rent goes to the vault. After the approvals (`checkRotation`),
 * the rotator sends the instructions, which write the new key and the new
 * record together.
 */
export async function rotateSmartAccount(
  input: Readonly<{
    client: SprClient;
    settings: Address;
    rotator: Member;
    payer: TransactionSigner;
    approvers: readonly TransactionSigner[];
    keep: readonly Address[];
    add: readonly NewSigner[];
    threshold: number;
  }>,
): Promise<Rotation> {
  const current = await checkApprovers(
    input.client,
    input.settings,
    input.approvers,
  );
  for (const signer of input.add) {
    if (current.signers.some((entry) => entry.key === signer.key)) {
      throw new Error(`${signer.key} is already a signer; list it in keep`);
    }
  }
  const published = await fetchCurrentKeyRecord(
    input.client,
    input.settings,
    current,
  );
  const { record } = published;
  const kept = await Promise.all(
    input.keep.map(async (key): Promise<NewSigner> => {
      const signer = current.signers.find((entry) => entry.key === key);
      if (signer === undefined) {
        throw new Error(`${key} is not a current signer`);
      }
      return {
        key,
        permissions: signer.permissions,
        viewingPublicKey: await registeredViewingKey(input.client, key),
      };
    }),
  );
  const next = [...kept, ...input.add];

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
    const newRecord = buildKeyRecord({
      settings: input.settings,
      epoch: record.epoch + 1n,
      secrets: newSecrets,
      previousViewingKeys: [...previousViewingKeys, secrets.viewingKey],
      recipients: next,
    });
    checkKeyHistory(newRecord, record);
    const vault = await vaultAddress(input.settings);
    const upload = await prepareKeyRecordUpload({
      owner: vault,
      payer: input.payer,
      record: newRecord,
    });
    const instructions = await rotateSmartAccountInstructions({
      settings: input.settings,
      current,
      approvers: input.approvers,
      rentPayer: input.rotator.signer,
      record: newRecord,
      upload: upload.address,
      predecessor: published.address,
      next,
      threshold: input.threshold,
    });
    return { record: newRecord, upload, instructions };
  } finally {
    previousViewingKeys.forEach((key) => key.destroy());
    newSecrets.viewingKey.destroy();
    destroySecrets(secrets);
  }
}

// ---------------------------------------------------------------------------
// 3. Spend
// ---------------------------------------------------------------------------

export interface Payment {
  readonly recipient: ShieldedAddress;
  readonly asset: Address;
  readonly amount: bigint;
}

/**
 * Spend steps 3 to 6: builds a confidential transfer from the vault's UTXOs,
 * proves it with the shared nullifier secret, and wraps the SPP `transact`
 * in Squads `executeTransactionSyncV2`. The vault is the owner signer and
 * the SPP payer, so the vault needs SOL for the fees.
 */
export async function spendInstruction(
  input: Readonly<{
    client: SprClient;
    settings: Address;
    approvers: readonly TransactionSigner[];
    secrets: SharedSecrets;
    viewingKeys: readonly ViewingKey[];
    inputs: readonly Utxo[];
    payments: readonly Payment[];
  }>,
): Promise<Instruction> {
  await checkApprovers(input.client, input.settings, input.approvers);
  const vault = await vaultAddress(input.settings);
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
    const transact = await transactInstruction({
      payer: vault,
      ownerSigners: [vault],
      inputTree: input.client.tree,
      outputTree: input.client.tree,
      data,
    });
    return executeTransactionSyncInstruction({
      settings: input.settings,
      approvers: input.approvers,
      inner: [transact],
    });
  } finally {
    keys.shielded.destroy();
    keys.proving.destroy();
  }
}
