/**
 * Swig smart-wallet program: PDAs, the four instructions this SDK sends and a
 * decoder for the Swig account's roles. Layouts follow the deployed program
 * (`anagrambuild/swig-wallet`); only Ed25519 authorities are supported.
 */
import {
  AccountRole,
  address,
  getAddressDecoder,
  getAddressEncoder,
  getProgramDerivedAddress,
  type AccountMeta,
  type AccountSignerMeta,
  type Address,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";

import { ByteReader, ByteWriter } from "../bytes.js";
import { SYSTEM_PROGRAM_ADDRESS, compileInnerInstructions } from "../cpi.js";

export const SWIG_PROGRAM_ADDRESS = address(
  "swigypWHEksbC64pWKwah1WTeh9JXwx8H1rJHLdbQMB",
);

const CREATE_V1 = 0;
const ADD_AUTHORITY_V1 = 1;
const REMOVE_AUTHORITY_V1 = 2;
const SIGN_V2 = 11;
const SWIG_DISCRIMINATOR = 1;
const SWIG_HEADER_SIZE = 48;
const ROLE_POSITION_SIZE = 16;
const ACTION_HEADER_SIZE = 8;
/** SignV2 inner instructions may use at most this many accounts. */
const MAX_SIGN_ACCOUNTS = 254;
const ED25519_AUTHORITY = 1;
const utf8 = new TextEncoder();
const addressEncoder = getAddressEncoder();
const addressDecoder = getAddressDecoder();

/** Swig permission (action) types. */
export const SwigPermission = Object.freeze({
  SolLimit: 1,
  SolRecurringLimit: 2,
  Program: 3,
  All: 7,
  ManageAuthority: 8,
});

export type SwigAction =
  | Readonly<{ kind: "all" }>
  | Readonly<{ kind: "manageAuthority" }>
  | Readonly<{ kind: "program"; program: Address }>
  | Readonly<{ kind: "solLimit"; lamports: bigint }>
  | Readonly<{ kind: "solRecurringLimit"; lamports: bigint; window: bigint }>;

export interface SwigRole {
  readonly id: number;
  /** The Ed25519 authority, or undefined for another authority type. */
  readonly authority: Address | undefined;
  readonly authorityType: number;
  /** Permission type of each action, in order. */
  readonly permissions: readonly number[];
}

export interface SwigAccount {
  readonly id: Uint8Array;
  readonly roleCounter: number;
  readonly roles: readonly SwigRole[];
}

export interface Pda {
  readonly address: Address;
  readonly bump: number;
}

/** The Swig account of `id` (32 bytes). */
export async function swigAddress(id: Uint8Array): Promise<Pda> {
  if (id.length !== 32) throw new Error("a Swig id is 32 bytes");
  const [pda, bump] = await getProgramDerivedAddress({
    programAddress: SWIG_PROGRAM_ADDRESS,
    seeds: [utf8.encode("swig"), id],
  });
  return { address: pda, bump };
}

/** The wallet address: the System-owned PDA that signs the Swig's CPIs. */
export async function swigWalletAddress(swig: Address): Promise<Pda> {
  const [pda, bump] = await getProgramDerivedAddress({
    programAddress: SWIG_PROGRAM_ADDRESS,
    seeds: [utf8.encode("swig-wallet-address"), addressEncoder.encode(swig)],
  });
  return { address: pda, bump };
}

/** Each action: u16 type, u16 length, u32 end offset in the actions, data. */
export function encodeSwigActions(actions: readonly SwigAction[]): Uint8Array {
  const writer = new ByteWriter();
  let end = 0;
  for (const action of actions) {
    const [type, data] = actionBytes(action);
    end += ACTION_HEADER_SIZE + data.length;
    writer.u16(type).u16(data.length).u32(end).bytes(data);
  }
  return writer.finish();
}

function actionBytes(action: SwigAction): [number, Uint8Array] {
  switch (action.kind) {
    case "all":
      return [SwigPermission.All, new Uint8Array()];
    case "manageAuthority":
      return [SwigPermission.ManageAuthority, new Uint8Array()];
    case "program":
      return [
        SwigPermission.Program,
        Uint8Array.from(addressEncoder.encode(action.program)),
      ];
    case "solLimit":
      return [
        SwigPermission.SolLimit,
        new ByteWriter().u64(action.lamports).finish(),
      ];
    case "solRecurringLimit":
      return [
        SwigPermission.SolRecurringLimit,
        new ByteWriter()
          .u64(action.lamports) // recurring_amount
          .u64(action.window) // window in slots
          .u64(0n) // last_reset
          .u64(action.lamports) // current_amount
          .finish(),
      ];
  }
}

function signerMeta(
  signer: TransactionSigner,
  role: AccountRole,
): AccountSignerMeta {
  return { address: signer.address, role, signer } as AccountSignerMeta;
}

/**
 * `CreateV1`: a Swig whose root role (id 0) is the Ed25519 `authority` with
 * `actions`. `payer` funds the Swig account and the wallet address.
 */
export async function createSwigInstruction(
  input: Readonly<{
    payer: TransactionSigner;
    id: Uint8Array;
    authority: Address;
    actions: readonly SwigAction[];
  }>,
): Promise<Instruction> {
  const swig = await swigAddress(input.id);
  const wallet = await swigWalletAddress(swig.address);
  return {
    programAddress: SWIG_PROGRAM_ADDRESS,
    accounts: [
      { address: swig.address, role: AccountRole.WRITABLE },
      signerMeta(input.payer, AccountRole.WRITABLE_SIGNER),
      { address: wallet.address, role: AccountRole.WRITABLE },
      { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data: new ByteWriter()
      .u16(CREATE_V1)
      .u16(ED25519_AUTHORITY)
      .u16(32) // authority_data_len
      .u8(swig.bump)
      .u8(wallet.bump)
      .bytes(input.id)
      .bytes(addressEncoder.encode(input.authority))
      .bytes(encodeSwigActions(input.actions))
      .finish(),
  };
}

/** Accounts of Add/RemoveAuthorityV1; the authority is account 3. */
function manageAccounts(
  swig: Address,
  payer: TransactionSigner,
  authority: TransactionSigner,
): AccountMeta[] {
  return [
    { address: swig, role: AccountRole.WRITABLE },
    signerMeta(payer, AccountRole.WRITABLE_SIGNER),
    { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    signerMeta(authority, AccountRole.READONLY_SIGNER),
  ];
}

/** Index of the Ed25519 authority among the Add/RemoveAuthorityV1 accounts. */
const MANAGE_AUTHORITY_INDEX = 3;

/**
 * `AddAuthorityV1`: `authority`, holding role `actingRoleId`, adds a role for
 * the Ed25519 `newAuthority` with `actions`. `payer` funds the reallocation.
 */
export function addAuthorityInstruction(
  input: Readonly<{
    swig: Address;
    payer: TransactionSigner;
    authority: TransactionSigner;
    actingRoleId: number;
    newAuthority: Address;
    actions: readonly SwigAction[];
  }>,
): Instruction {
  const actions = encodeSwigActions(input.actions);
  return {
    programAddress: SWIG_PROGRAM_ADDRESS,
    accounts: manageAccounts(input.swig, input.payer, input.authority),
    data: new ByteWriter()
      .u16(ADD_AUTHORITY_V1)
      .u16(32) // new_authority_data_len
      .u16(actions.length)
      .u16(ED25519_AUTHORITY)
      .u8(input.actions.length)
      .bytes([0, 0, 0])
      .u32(input.actingRoleId)
      .bytes(addressEncoder.encode(input.newAuthority))
      .bytes(actions)
      .u8(MANAGE_AUTHORITY_INDEX)
      .finish(),
  };
}

/** `RemoveAuthorityV1`: `authority`, holding `actingRoleId`, removes `roleId`. */
export function removeAuthorityInstruction(
  input: Readonly<{
    swig: Address;
    payer: TransactionSigner;
    authority: TransactionSigner;
    actingRoleId: number;
    roleId: number;
  }>,
): Instruction {
  return {
    programAddress: SWIG_PROGRAM_ADDRESS,
    accounts: manageAccounts(input.swig, input.payer, input.authority),
    data: new ByteWriter()
      .u16(REMOVE_AUTHORITY_V1)
      .u16(1) // authority_payload_len
      .bytes([0, 0, 0, 0])
      .u32(input.actingRoleId)
      .u32(input.roleId)
      .u8(MANAGE_AUTHORITY_INDEX)
      .finish(),
  };
}

/** Index of the Ed25519 authority among the SignV2 accounts. */
const SIGN_AUTHORITY_INDEX = 2;

/**
 * `SignV2`: `authority`, holding role `roleId`, has the Swig run `inner` with
 * its wallet address as signer. Swig checks the role's permissions for every
 * inner instruction the wallet address signs. It must be a top-level
 * instruction.
 */
export async function signV2Instruction(
  input: Readonly<{
    swig: Address;
    roleId: number;
    authority: TransactionSigner;
    inner: readonly Instruction[];
  }>,
): Promise<Instruction> {
  const wallet = (await swigWalletAddress(input.swig)).address;
  const { payload, accounts } = compileInnerInstructions(
    input.inner,
    [
      { address: input.swig, role: AccountRole.WRITABLE },
      { address: wallet, role: AccountRole.WRITABLE },
      signerMeta(input.authority, AccountRole.READONLY_SIGNER),
    ],
    wallet,
    MAX_SIGN_ACCOUNTS,
  );
  return {
    programAddress: SWIG_PROGRAM_ADDRESS,
    accounts,
    data: new ByteWriter()
      .u16(SIGN_V2)
      .u16(payload.length)
      .u32(input.roleId)
      .bytes(payload)
      .u8(SIGN_AUTHORITY_INDEX)
      .finish(),
  };
}

/**
 * Decodes a Swig account: a 48-byte header, then each role as a 16-byte
 * position (authority type and length, action count, id, end offset), the
 * authority and its actions.
 */
export function decodeSwig(data: Uint8Array): SwigAccount {
  const header = new ByteReader(
    data.subarray(0, SWIG_HEADER_SIZE),
    "Swig account",
  );
  if (header.u8("discriminator") !== SWIG_DISCRIMINATOR) {
    throw new Error("not a Swig account");
  }
  header.u8("bump");
  const id = header.bytes(32, "id");
  const count = header.u16("roles");
  const roleCounter = header.u32("role_counter");
  const roleBuffer = data.subarray(SWIG_HEADER_SIZE);
  const roles: SwigRole[] = [];
  let cursor = 0;
  for (let index = 0; index < count; index += 1) {
    const position = new ByteReader(
      roleBuffer.subarray(cursor, cursor + ROLE_POSITION_SIZE),
      "Swig role",
    );
    const authorityType = position.u16("authority_type");
    const authorityLength = position.u16("authority_length");
    const actionCount = position.u16("num_actions");
    position.u16("padding");
    const roleId = position.u32("id");
    const boundary = position.u32("boundary");
    if (boundary <= cursor || boundary > roleBuffer.length) {
      throw new Error("Swig role has an invalid boundary");
    }
    const body = new ByteReader(
      roleBuffer.subarray(cursor + ROLE_POSITION_SIZE, boundary),
      "Swig role",
    );
    const authorityBytes = body.bytes(authorityLength, "authority");
    const permissions: number[] = [];
    for (let action = 0; action < actionCount; action += 1) {
      permissions.push(body.u16("action type"));
      const length = body.u16("action length");
      body.u32("action boundary");
      body.bytes(length, "action data");
    }
    body.end();
    roles.push({
      id: roleId,
      authorityType,
      authority:
        authorityType === ED25519_AUTHORITY && authorityLength === 32
          ? addressDecoder.decode(authorityBytes)
          : undefined,
      permissions,
    });
    cursor = boundary;
  }
  return { id, roleCounter, roles };
}

/** The role whose Ed25519 authority is `authority`. */
export function swigRoleOf(
  swig: SwigAccount,
  authority: Address,
): SwigRole | undefined {
  return swig.roles.find((role) => role.authority === authority);
}
