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
import { ViewingKey } from "@heliuslabs/spr/keypair";
import type { SprClient } from "@heliuslabs/spr/client";
import type { Utxo } from "@heliuslabs/spr/transaction";

import {
  buildKeyRecord,
  compareAddresses,
  encodeKeyRecord,
  generateNullifierKey,
  isCurrentKeyRecord,
  type KeyRecipient,
  type KeyRecord,
  type SharedSecrets,
} from "../keyRecord.js";
import {
  registerVaultKeysInstruction,
  prepareKeyRecordUpload,
  updateKeysInstruction,
  type KeyRecordPublication,
} from "../registry.js";
import {
  publishRecordInstructions,
  type RecordUpload,
} from "../record/storage.js";
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
} from "./program.js";
import {
  accountData,
  checkEntryOpens,
  checkInstructionsMatch,
  checkProposedKeyRecord as checkProposedVaultRecord,
  destroySecrets,
  fetchCurrentKeyRecord as fetchCurrentVaultRecord,
  recoverRecordKeys,
  registeredViewingKey,
  rotatedKeyRecord,
  vaultTransactInstruction,
  type Member,
  type Payment,
  type VaultSecrets,
} from "../vault.js";

/** A signer to add: its Squads permissions and its viewing public key. */
export interface NewSigner extends SmartAccountSigner, KeyRecipient {}

export async function fetchSettings(
  client: SprClient,
  settings: Address,
): Promise<Settings> {
  const data = await accountData(client, settings);
  if (data === undefined)
    throw new Error(`Squads Settings ${settings} does not exist`);
  return decodeSettings(data);
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
  return fetchCurrentVaultRecord(
    client,
    settings,
    await vaultAddress(settings),
    decoded.signers.map((signer) => signer.key),
  );
}

/**
 * Recovers the shared secrets of the current key record, and the viewing
 * keys of every previous epoch, current first; see `recoverRecordKeys`.
 */
export async function recoverVaultKeys(
  input: Readonly<{
    client: SprClient;
    settings: Address;
    member: Member;
  }>,
): Promise<VaultSecrets> {
  const { record } = await fetchCurrentKeyRecord(
    input.client,
    input.settings,
    await fetchSettings(input.client, input.settings),
  );
  return recoverRecordKeys(record, input.member);
}

async function checkProposedKeyRecord(
  input: Readonly<{
    client: SprClient;
    settings: Address;
    record: KeyRecord;
    upload: Address;
  }>,
): Promise<KeyRecordPublication | undefined> {
  return checkProposedVaultRecord({
    ...input,
    accountId: input.settings,
    vault: await vaultAddress(input.settings),
  });
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
  const record = rotatedKeyRecord({
    accountId: input.settings,
    record: published.record,
    rotator: input.rotator,
    recipients: next,
  });
  const vault = await vaultAddress(input.settings);
  const upload = await prepareKeyRecordUpload({
    owner: vault,
    payer: input.payer,
    record,
  });
  const instructions = await rotateSmartAccountInstructions({
    settings: input.settings,
    current,
    approvers: input.approvers,
    rentPayer: input.rotator.signer,
    record,
    upload: upload.address,
    predecessor: published.address,
    next,
    threshold: input.threshold,
  });
  return { record, upload, instructions };
}

// ---------------------------------------------------------------------------
// 3. Spend
// ---------------------------------------------------------------------------

/**
 * Spend steps 3 to 6: builds and proves the vault's SPP `transact` (see
 * `vaultTransactInstruction`) and wraps it in Squads
 * `executeTransactionSyncV2`. The vault needs SOL for the fees.
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
  const transact = await vaultTransactInstruction({
    ...input,
    vault: await vaultAddress(input.settings),
  });
  return executeTransactionSyncInstruction({
    settings: input.settings,
    approvers: input.approvers,
    inner: [transact],
  });
}
