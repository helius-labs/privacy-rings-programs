/** Rotate (design.md, flow 2) for a Swig wallet. */
import type { Address, Instruction, TransactionSigner } from "@solana/kit";
import type { SprClient } from "@heliuslabs/spr/client";

import {
  encodeKeyRecord,
  type KeyRecipient,
  type KeyRecord,
} from "../keyRecord.js";
import { registeredViewingKey, updateKeysInstruction } from "../registry.js";
import {
  publishRecordInstructions,
  type RecordUpload,
} from "../record/storage.js";
import { prepareKeyRecordUpload } from "../record/keyRecordStorage.js";
import {
  addAuthorityInstruction,
  removeAuthorityInstruction,
  signV2Instruction,
  swigRoleOf,
} from "./program.js";
import { rotatedKeyRecord } from "../core/rotate.js";
import { type Member } from "../core/member.js";
import {
  VIEW_KEY_AUTHORITY_ROLE,
  checkViewKeyAuthority,
  fetchCurrentSwigRecord,
  fetchSwig,
  memberActions,
  roleId,
  swigMembers,
  swigVaultAddress,
  type SolBudget,
} from "./account.js";

export interface SwigRotation {
  readonly record: KeyRecord;
  /** Send these upload transactions before the final atomic transaction. */
  readonly upload: RecordUpload;
  /**
   * In order: `SignV2` with the user registry `update_keys` and the
   * publication of the uploaded record, which closes the previous record,
   * then `AddAuthorityV1` for each added member and `RemoveAuthorityV1` for
   * each removed one. Send them in one transaction.
   */
  readonly instructions: readonly Instruction[];
}

/**
 * Rotate for a registered vault, by the view key authority: recovers the
 * current secrets, encrypts a new shared viewing key and the unchanged
 * nullifier secret to the authority, the kept members and the added ones,
 * and returns the new record and the rotate instructions. The authority's and
 * kept members' viewing keys come from the user registry, so both must be
 * registered. `payer` funds the upload and the
 * Swig reallocation.
 */
export async function rotateSwigAccount(
  input: Readonly<{
    client: SprClient;
    swig: Address;
    authority: Member;
    payer: TransactionSigner;
    keep: readonly Address[];
    add: readonly KeyRecipient[];
    memberBudget: SolBudget;
  }>,
): Promise<SwigRotation> {
  const authority = input.authority.signer;
  const current = await fetchSwig(input.client, input.swig);
  checkViewKeyAuthority(current, authority.address);
  const members = swigMembers(current).filter(
    (member) => member !== authority.address,
  );
  for (const member of input.add) {
    if (swigRoleOf(current, member.key) !== undefined) {
      throw new Error(`${member.key} already has a Swig role; list it in keep`);
    }
  }
  for (const key of input.keep) {
    if (!members.includes(key)) throw new Error(`${key} is not a member`);
  }
  const published = await fetchCurrentSwigRecord(
    input.client,
    input.swig,
    current,
  );
  const kept = await Promise.all(
    input.keep.map(
      async (key): Promise<KeyRecipient> => ({
        key,
        viewingPublicKey: await registeredViewingKey(input.client, key),
      }),
    ),
  );
  const record = rotatedKeyRecord({
    accountId: input.swig,
    record: published.record,
    rotator: input.authority,
    recipients: [
      {
        key: authority.address,
        viewingPublicKey: await registeredViewingKey(
          input.client,
          authority.address,
        ),
      },
      ...kept,
      ...input.add,
    ],
  });
  const vault = await swigVaultAddress(input.swig);
  const upload = await prepareKeyRecordUpload({
    owner: vault,
    payer: input.payer,
    record,
  });
  const removed = members.filter((member) => !input.keep.includes(member));
  const instructions = [
    await signV2Instruction({
      swig: input.swig,
      roleId: VIEW_KEY_AUTHORITY_ROLE,
      authority,
      inner: [
        await updateKeysInstruction(vault, record.sharedViewingPublicKey),
        ...(await publishRecordInstructions({
          owner: vault,
          upload: upload.address,
          predecessor: published.address,
          bytes: encodeKeyRecord(record),
        })),
      ],
    }),
    ...input.add.map((member) =>
      addAuthorityInstruction({
        swig: input.swig,
        payer: input.payer,
        authority,
        actingRoleId: VIEW_KEY_AUTHORITY_ROLE,
        newAuthority: member.key,
        actions: memberActions(input.memberBudget),
      }),
    ),
    ...removed.map((member) =>
      removeAuthorityInstruction({
        swig: input.swig,
        payer: input.payer,
        authority,
        actingRoleId: VIEW_KEY_AUTHORITY_ROLE,
        roleId: roleId(current, member),
      }),
    ),
  ];
  return { record, upload, instructions };
}
