/** Create (design.md, flow 1) for a Swig wallet. */
import type { Address, Instruction, TransactionSigner } from "@solana/kit";
import { ViewingKey } from "@heliuslabs/spr/keypair";

import {
  buildKeyRecord,
  generateNullifierKey,
  type KeyRecipient,
  type KeyRecord,
  type SharedSecrets,
} from "../keyRecord.js";
import {
  addAuthorityInstruction,
  createSwigInstruction,
  swigAddress,
} from "./program.js";
import { destroySecrets } from "../vault.js";
import {
  VIEW_KEY_AUTHORITY_ROLE,
  memberActions,
  swigVaultAddress,
  viewKeyAuthorityActions,
  type SolBudget,
} from "./account.js";

export interface CreatedSwig {
  readonly swig: Address;
  readonly vault: Address;
  /** Record 0; Register writes it on chain. */
  readonly record: KeyRecord;
  /**
   * `CreateV1` with the view key authority as root, then `AddAuthorityV1`
   * for each member. The payer and the authority sign them.
   */
  readonly instructions: readonly Instruction[];
}

/**
 * Creates a Swig whose root role is the view key authority and adds each
 * member, and generates the shared secrets and key record 0 for all of them.
 * Fund the vault before Register: it pays the rent of its registry record
 * and storage pointer.
 */
export async function createSwigAccount(
  input: Readonly<{
    payer: TransactionSigner;
    authority: TransactionSigner;
    /** The view key authority's viewing public key. */
    authorityViewingKey: KeyRecipient["viewingPublicKey"];
    members: readonly KeyRecipient[];
    authorityBudget: SolBudget;
    memberBudget: SolBudget;
  }>,
): Promise<CreatedSwig> {
  if (input.members.some((member) => member.key === input.authority.address)) {
    throw new Error("the view key authority is not also a member role");
  }
  const id = crypto.getRandomValues(new Uint8Array(32));
  const swig = (await swigAddress(id)).address;
  const vault = await swigVaultAddress(swig);
  const secrets: SharedSecrets = {
    viewingKey: ViewingKey.generate(),
    nullifierKey: generateNullifierKey(),
  };
  try {
    const record = buildKeyRecord({
      settings: swig,
      epoch: 0n,
      secrets,
      previousViewingKeys: [],
      recipients: [
        {
          key: input.authority.address,
          viewingPublicKey: input.authorityViewingKey,
        },
        ...input.members,
      ],
    });
    const instructions = [
      await createSwigInstruction({
        payer: input.payer,
        id,
        authority: input.authority.address,
        actions: viewKeyAuthorityActions(input.authorityBudget),
      }),
      ...input.members.map((member) =>
        addAuthorityInstruction({
          swig,
          payer: input.payer,
          authority: input.authority,
          actingRoleId: VIEW_KEY_AUTHORITY_ROLE,
          newAuthority: member.key,
          actions: memberActions(input.memberBudget),
        }),
      ),
    ];
    return { swig, vault, record, instructions };
  } finally {
    destroySecrets(secrets);
  }
}
