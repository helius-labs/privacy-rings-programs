/** Rotate (design.md, flow 2) for a Squads smart account. */
import {
  createNoopSigner,
  type Address,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import type { SprClient } from "@heliuslabs/spr/client";

import {
  checkEntryOpens,
  checkInstructionsMatch,
  compareAddresses,
  type KeyRecord,
  type Member,
  prepareKeyRecordUpload,
  type RecordUpload,
  rotatedKeyRecord,
  updateKeyRecordInstructions,
  withRegisteredViewingKeys,
} from "@heliuslabs/shared-key-storage";
import {
  checkSynchronousConsensus,
  executeSettingsTransactionSyncInstruction,
  executeTransactionSyncV2Instruction,
  rotationActions,
  smartAccountAddress,
  type Settings,
  type SmartAccountSigner,
} from "./program.js";
import {
  checkApprovers,
  checkProposedKeyRecord,
  fetchCurrentKeyRecord,
  fetchSettings,
  sortedSigners,
  type NewSigner,
} from "./account.js";

export interface SmartAccountRotation {
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
  const vault = await smartAccountAddress(input.settings);
  const instructions: Instruction[] = [
    await executeTransactionSyncV2Instruction({
      settings: input.settings,
      approvers: input.approvers,
      inner: await updateKeyRecordInstructions({
        vault,
        record,
        upload: input.upload,
        predecessor: input.predecessor,
      }),
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
): Promise<SmartAccountRotation> {
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
  const kept = await withRegisteredViewingKeys(
    input.client,
    input.keep.map((key) => {
      const signer = current.signers.find((entry) => entry.key === key);
      if (signer === undefined) {
        throw new Error(`${key} is not a current signer`);
      }
      return { key, permissions: signer.permissions };
    }),
  );
  const next: NewSigner[] = [...kept, ...input.add];
  const record = rotatedKeyRecord({
    accountId: input.settings,
    record: published.record,
    rotator: input.rotator,
    recipients: next,
  });
  const vault = await smartAccountAddress(input.settings);
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
  checkSynchronousConsensus(current, input.approvers);
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
