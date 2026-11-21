/**
 * Shared by the wallet programs that run inner instructions signed by a PDA
 * (Squads `executeTransactionSyncV2`, Swig `SignV2`): both take the inner
 * instructions as one compact payload.
 */
import {
  AccountRole,
  mergeRoles,
  type AccountMeta,
  type Address,
  type Instruction,
} from "@solana/kit";

import { ByteWriter } from "@heliuslabs/shared-key-storage";

/**
 * Compiles `instructions` into a compact payload: a u8 count, then per
 * instruction a u8 program index, a u8 account count, u8 account indexes and
 * u16-length data. Indexes count from the first of `leading`, which are
 * followed by every other account the instructions use. `pda` signs in the
 * CPI, so it loses its signer flag on the outer instruction and must be
 * among `leading`.
 */
export function compileInnerInstructions(
  instructions: readonly Instruction[],
  leading: readonly AccountMeta[],
  pda: Address,
  maxAccounts = 256,
): Readonly<{ payload: Uint8Array; accounts: AccountMeta[] }> {
  const accounts: AccountMeta[] = [];
  const indexOf = (meta: AccountMeta): number => {
    const found = accounts.findIndex(
      (existing) => existing.address === meta.address,
    );
    // `accounts[-1]` is undefined, so a new address takes this branch.
    const existing = accounts[found];
    if (existing === undefined) {
      // Payload indexes are u8.
      if (accounts.length === maxAccounts)
        throw new Error(
          `inner instructions use more than ${maxAccounts} accounts`,
        );
      accounts.push(meta);
      return accounts.length - 1;
    }
    accounts[found] = {
      ...existing,
      ...("signer" in meta ? { signer: meta.signer } : {}),
      role: mergeRoles(existing.role, meta.role),
    } as AccountMeta;
    return found;
  };
  for (const meta of leading) indexOf(meta);
  const writer = new ByteWriter().u8(instructions.length);
  for (const instruction of instructions) {
    writer.u8(
      indexOf({
        address: instruction.programAddress,
        role: AccountRole.READONLY,
      }),
    );
    const metas = instruction.accounts ?? [];
    writer.u8(metas.length);
    for (const meta of metas) writer.u8(indexOf(meta));
    const data = instruction.data ?? new Uint8Array();
    writer.u16(data.length).bytes(data);
  }
  // The PDA starts writable among `leading`, so merging never narrows it;
  // only its signer flag is dropped.
  const outer = accounts.map(
    (meta): AccountMeta =>
      meta.address === pda
        ? { address: pda, role: AccountRole.WRITABLE }
        : meta,
  );
  return { payload: writer.finish(), accounts: outer };
}
