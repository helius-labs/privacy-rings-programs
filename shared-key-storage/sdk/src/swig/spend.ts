/** Spend (design.md, flow 3) for a Swig wallet. */
import type { Address, Instruction, TransactionSigner } from "@solana/kit";
import type { ViewingKey } from "@heliuslabs/spr/keypair";
import type { SprClient } from "@heliuslabs/spr/client";
import type { Utxo } from "@heliuslabs/spr/transaction";

import type { SharedSecrets } from "../keyRecord.js";
import { signV2Instruction } from "./program.js";
import { vaultTransactInstruction, type Payment } from "../core/spend.js";
import { fetchSwig, roleId, swigVaultAddress } from "./account.js";

/**
 * Spend by any one authority of the Swig: builds and proves the vault's SPP
 * `transact` (see `vaultTransactInstruction`) and wraps it in `SignV2` under
 * the spender's role. The vault needs SOL for the fees, which count against
 * the role's SOL budget.
 */
export async function swigSpendInstruction(
  input: Readonly<{
    client: SprClient;
    swig: Address;
    spender: TransactionSigner;
    secrets: SharedSecrets;
    viewingKeys: readonly ViewingKey[];
    inputs: readonly Utxo[];
    payments: readonly Payment[];
  }>,
): Promise<Instruction> {
  const decoded = await fetchSwig(input.client, input.swig);
  const transact = await vaultTransactInstruction({
    ...input,
    vault: await swigVaultAddress(input.swig),
  });
  return signV2Instruction({
    swig: input.swig,
    roleId: roleId(decoded, input.spender.address),
    authority: input.spender,
    inner: [transact],
  });
}
