/** Register (design.md, Create step 6) for a Squads smart account. */
import {
  createNoopSigner,
  type Address,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import type { SprClient } from "@heliuslabs/spr/client";

import {
  encodeKeyRecord,
  isCurrentKeyRecord,
  type KeyRecord,
} from "../keyRecord.js";
import { registerVaultKeysInstruction } from "../registry.js";
import { publishRecordInstructions } from "../record/storage.js";
import { executeTransactionSyncInstruction, vaultAddress } from "./program.js";
import { checkInstructionsMatch, type Member } from "../vault.js";
import { checkApprovers, checkOwnEntry } from "./account.js";

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
