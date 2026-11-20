/**
 * SPL Record program: the four instructions this SDK sends and a decoder for
 * Record accounts. A Record account is a 33-byte header (version, authority)
 * followed by data that only the authority can write or close.
 */
import {
  AccountRole,
  address,
  getAddressDecoder,
  type AccountMeta,
  type Address,
  type Instruction,
} from "@solana/kit";

import { ByteReader, ByteWriter } from "../bytes.js";

/** The SPL Record program (mainnet and devnet). */
export const RECORD_PROGRAM_ADDRESS = address(
  "recr1L3PCGKLbckBqMNcJhuuyU1zgo8nBhfLVsJNwr5",
);
/** Record account header: version (1) and authority. */
export const RECORD_HEADER_SIZE = 1 + 32;
/** The most data a Record account can hold: the 10 MiB account limit. */
export const MAX_RECORD_SIZE = 10 * 1024 * 1024 - RECORD_HEADER_SIZE;

const RECORD_VERSION = 1;
const INITIALIZE = 0;
const WRITE = 1;
const SET_AUTHORITY = 2;
const CLOSE = 3;
const addressDecoder = getAddressDecoder();

/** Splits a Record account into its authority and data, checking the version. */
export function decodeRecordAccount(bytes: Uint8Array): {
  readonly authority: Address;
  readonly data: Uint8Array;
} {
  const reader = new ByteReader(bytes, "record account");
  if (reader.u8("version") !== RECORD_VERSION) {
    throw new Error("not an initialized record account");
  }
  const authority = addressDecoder.decode(reader.bytes(32, "authority"));
  const data = reader.bytes(bytes.length - RECORD_HEADER_SIZE, "data");
  reader.end();
  return { authority, data };
}

function recordInstruction(
  accounts: readonly AccountMeta[],
  data: Uint8Array,
): Instruction {
  return { programAddress: RECORD_PROGRAM_ADDRESS, accounts, data };
}

/** `Initialize`: sets the authority of an allocated, uninitialized account. */
export function recordInitializeInstruction(
  record: Address,
  authority: Address,
): Instruction {
  return recordInstruction(
    [
      { address: record, role: AccountRole.WRITABLE },
      { address: authority, role: AccountRole.READONLY },
    ],
    Uint8Array.of(INITIALIZE),
  );
}

/** `Write`: the authority writes `bytes` at `offset` in the data. */
export function recordWriteInstruction(
  record: Address,
  authority: AccountMeta,
  offset: number,
  bytes: Uint8Array,
): Instruction {
  return recordInstruction(
    [{ address: record, role: AccountRole.WRITABLE }, authority],
    new ByteWriter()
      .u8(WRITE)
      .u64(BigInt(offset))
      .u32(bytes.length)
      .bytes(bytes)
      .finish(),
  );
}

/** `SetAuthority`: the authority hands the account to `newAuthority`. */
export function recordSetAuthorityInstruction(
  record: Address,
  authority: AccountMeta,
  newAuthority: Address,
): Instruction {
  return recordInstruction(
    [
      { address: record, role: AccountRole.WRITABLE },
      authority,
      { address: newAuthority, role: AccountRole.READONLY },
    ],
    Uint8Array.of(SET_AUTHORITY),
  );
}

/** `CloseAccount`: the authority closes the account and sends its rent on. */
export function recordCloseInstruction(
  record: Address,
  authority: AccountMeta,
  destination: Address,
): Instruction {
  return recordInstruction(
    [
      { address: record, role: AccountRole.WRITABLE },
      authority,
      { address: destination, role: AccountRole.WRITABLE },
    ],
    Uint8Array.of(CLOSE),
  );
}
