/** Spend (design.md, flow 3) for a Squads smart account. */
import type { Address, Instruction, TransactionSigner } from "@solana/kit";
import type { ViewingKey } from "@heliuslabs/spr/keypair";
import type { SprClient } from "@heliuslabs/spr/client";
import type { Utxo } from "@heliuslabs/spr/transaction";

import type { SharedSecrets } from "../keyRecord.js";
import { executeTransactionSyncInstruction, vaultAddress } from "./program.js";
import { vaultTransactInstruction, type Payment } from "../vault.js";
import { checkApprovers } from "./account.js";

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
