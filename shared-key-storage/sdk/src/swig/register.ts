/** Register (design.md, Create step 6) for a Swig wallet. */
import type { Address, Instruction, TransactionSigner } from "@solana/kit";
import type { SprClient } from "@heliuslabs/spr/client";

import {
  encodeKeyRecord,
  isCurrentKeyRecord,
  type KeyRecord,
} from "../keyRecord.js";
import { registerVaultKeysInstruction } from "../registry.js";
import { publishRecordInstructions } from "../record/storage.js";
import { signV2Instruction } from "./program.js";
import {
  VIEW_KEY_AUTHORITY_ROLE,
  checkViewKeyAuthority,
  fetchSwig,
  swigMembers,
  swigVaultAddress,
} from "./account.js";

/**
 * `SignV2` by the view key authority with an inner user registry `register`
 * of the record's public keys and the first publication of its upload, both
 * signed by the vault. The record must name exactly the Swig's authorities.
 * `register` fails on chain once the vault is registered.
 */
export async function registerSwigVaultInstruction(
  input: Readonly<{
    client: SprClient;
    swig: Address;
    authority: TransactionSigner;
    record: KeyRecord;
    upload: Address;
  }>,
): Promise<Instruction> {
  const decoded = await fetchSwig(input.client, input.swig);
  checkViewKeyAuthority(decoded, input.authority.address);
  if (input.record.epoch !== 0n) {
    throw new Error(`Register writes record 0, not ${input.record.epoch}`);
  }
  if (
    !isCurrentKeyRecord(input.record, {
      settings: input.swig,
      signers: swigMembers(decoded),
      registeredViewingPublicKey: input.record.sharedViewingPublicKey,
    })
  ) {
    throw new Error("the key record does not name the Swig's authorities");
  }
  const vault = await swigVaultAddress(input.swig);
  return signV2Instruction({
    swig: input.swig,
    roleId: VIEW_KEY_AUTHORITY_ROLE,
    authority: input.authority,
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
