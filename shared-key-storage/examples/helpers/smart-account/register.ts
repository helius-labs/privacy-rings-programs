/** Register (design.md, Create step 6) for a Squads smart account. */
import {
  createNoopSigner,
  type Address,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import type { SprClient } from "@heliuslabs/spr/client";

import {
  checkInstructionsMatch,
  createKeyRecordInstructions,
  isCurrentKeyRecord,
  type KeyRecord,
  type Member,
} from "@heliuslabs/shared-key-storage";
import {
  executeTransactionSyncV2Instruction,
  smartAccountAddress,
} from "./program.js";
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
export async function registerSmartAccountVaultInstruction(
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
  if (
    !isCurrentKeyRecord(input.record, {
      accountId: input.settings,
      signers: decoded.signers.map((signer) => signer.key),
      registeredViewingPublicKey: input.record.sharedViewingPublicKey,
    })
  ) {
    throw new Error("the key record does not name the Squads signers");
  }
  const vault = await smartAccountAddress(input.settings);
  return executeTransactionSyncV2Instruction({
    settings: input.settings,
    approvers: input.approvers,
    inner: await createKeyRecordInstructions({
      vault,
      record: input.record,
      upload: input.upload,
    }),
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
      await registerSmartAccountVaultInstruction({
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
