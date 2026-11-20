/**
 * The Create, Register, Rotate and Spend flows of design.md for a Swig
 * wallet. The vault is the Swig wallet address; Swig signs for it in
 * `SignV2`. Swig has no threshold: each role acts alone, so the roles split
 * the work by permission.
 *
 * - The view key authority is the root role (id 0). It alone can register
 *   the vault, publish key records and add or remove members. It always has
 *   an entry in the key record, since a rotation decrypts the current record.
 * - Every other role is a member. It can spend through the shielded pool,
 *   within a SOL limit for fees, but cannot touch key records, the user
 *   registry or membership.
 *
 * Swig checks a role's program permissions on every inner instruction the
 * wallet address signs, so the split is enforced on chain.
 */
import type { Address, Instruction, TransactionSigner } from "@solana/kit";
import {
  SHIELDED_POOL_PROGRAM_ID,
  USER_REGISTRY_PROGRAM_ID,
} from "@heliuslabs/spr/interface";
import { ViewingKey } from "@heliuslabs/spr/keypair";
import type { SprClient } from "@heliuslabs/spr/client";
import type { Utxo } from "@heliuslabs/spr/transaction";

import { SYSTEM_PROGRAM_ADDRESS } from "../cpi.js";
import {
  buildKeyRecord,
  encodeKeyRecord,
  generateNullifierKey,
  isCurrentKeyRecord,
  type KeyRecipient,
  type KeyRecord,
  type SharedSecrets,
} from "../keyRecord.js";
import {
  prepareKeyRecordUpload,
  registerVaultKeysInstruction,
  updateKeysInstruction,
  type KeyRecordPublication,
} from "../registry.js";
import {
  publishRecordInstructions,
  type RecordUpload,
} from "../record/storage.js";
import { RECORD_PROGRAM_ADDRESS } from "../record/program.js";
import {
  addAuthorityInstruction,
  createSwigInstruction,
  decodeSwig,
  removeAuthorityInstruction,
  signV2Instruction,
  swigAddress,
  swigRoleOf,
  swigWalletAddress,
  type SwigAccount,
  type SwigAction,
} from "./program.js";
import {
  accountData,
  destroySecrets,
  fetchCurrentKeyRecord,
  recoverRecordKeys,
  registeredViewingKey,
  rotatedKeyRecord,
  vaultTransactInstruction,
  type Member,
  type Payment,
  type VaultSecrets,
} from "../vault.js";

/** The view key authority's role. */
export const VIEW_KEY_AUTHORITY_ROLE = 0;

/** A recurring SOL budget: `lamports` per `window` slots. */
export interface SolBudget {
  readonly lamports: bigint;
  readonly window: bigint;
}

/**
 * Root role: membership, key records (System for the pointer's rent, Record,
 * the user registry) and private spends, within `budget` for rent and fees.
 */
export function viewKeyAuthorityActions(budget: SolBudget): SwigAction[] {
  return [
    { kind: "manageAuthority" },
    { kind: "program", program: SYSTEM_PROGRAM_ADDRESS },
    { kind: "program", program: RECORD_PROGRAM_ADDRESS },
    { kind: "program", program: USER_REGISTRY_PROGRAM_ID },
    { kind: "program", program: SHIELDED_POOL_PROGRAM_ID },
    { kind: "solRecurringLimit", ...budget },
  ];
}

/** Member role: private spends only, within `budget` for fees. */
export function memberActions(budget: SolBudget): SwigAction[] {
  return [
    { kind: "program", program: SHIELDED_POOL_PROGRAM_ID },
    { kind: "solRecurringLimit", ...budget },
  ];
}

export async function fetchSwig(
  client: SprClient,
  swig: Address,
): Promise<SwigAccount> {
  const data = await accountData(client, swig);
  if (data === undefined) throw new Error(`Swig ${swig} does not exist`);
  return decodeSwig(data);
}

/** The Ed25519 authorities of every role: the key record's signers. */
export function swigMembers(swig: SwigAccount): Address[] {
  return swig.roles.map((role) => {
    if (role.authority === undefined) {
      throw new Error(`Swig role ${role.id} is not an Ed25519 authority`);
    }
    return role.authority;
  });
}

/** The vault: the Swig wallet address. */
export async function swigVaultAddress(swig: Address): Promise<Address> {
  return (await swigWalletAddress(swig)).address;
}

/** Throws unless `authority` holds the view key authority role. */
function checkViewKeyAuthority(swig: SwigAccount, authority: Address): void {
  if (swigRoleOf(swig, authority)?.id !== VIEW_KEY_AUTHORITY_ROLE) {
    throw new Error(`${authority} is not the Swig's view key authority`);
  }
}

/** The role id of `signer`, which must be an authority of `swig`. */
function roleId(swig: SwigAccount, signer: Address): number {
  const role = swigRoleOf(swig, signer);
  if (role === undefined) throw new Error(`${signer} has no Swig role`);
  return role.id;
}

/**
 * The current key record of a registered vault: it must name exactly the
 * Swig's authorities.
 */
async function fetchCurrentSwigRecord(
  client: SprClient,
  swig: Address,
  decoded: SwigAccount,
): Promise<KeyRecordPublication> {
  return fetchCurrentKeyRecord(
    client,
    swig,
    await swigVaultAddress(swig),
    swigMembers(decoded),
  );
}

/**
 * Recovers `member`'s shared secrets of the current key record and every old
 * viewing key, current first; see `recoverRecordKeys`.
 */
export async function recoverSwigVaultKeys(
  input: Readonly<{ client: SprClient; swig: Address; member: Member }>,
): Promise<VaultSecrets> {
  const { record } = await fetchCurrentSwigRecord(
    input.client,
    input.swig,
    await fetchSwig(input.client, input.swig),
  );
  return recoverRecordKeys(record, input.member);
}

// ---------------------------------------------------------------------------
// 1. Create
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Create step 6. Register
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 2. Rotate
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 3. Spend
// ---------------------------------------------------------------------------

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
