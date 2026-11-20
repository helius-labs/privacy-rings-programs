/**
 * Key-record storage on the SPL Record program, with no custom program.
 *
 * - A record is a Record account: a 33-byte header (version, authority) and
 *   the record bytes. A payer creates it, writes it in chunks and finally
 *   hands its authority to the owner, which freezes the bytes.
 * - The owner's pointer is a second Record account at
 *   `createWithSeed(owner, POINTER_SEED, Record)`, controlled by the owner. It
 *   names the current record and the SHA-256 of its bytes.
 * - Publication is a few instructions the owner signs in one transaction:
 *   write the pointer and close the replaced record, whose rent goes to the
 *   owner.
 *
 * The Record program enforces only "the authority writes and closes". Every
 * other rule lives here: readers check the pointer's owner and authority, the
 * record's authority and the hash before trusting a record.
 */
import { createHash } from "node:crypto";
import {
  AccountRole,
  address,
  createAddressWithSeed,
  fetchEncodedAccount,
  generateKeyPairSigner,
  getAddressDecoder,
  getAddressEncoder,
  type AccountMeta,
  type AccountSignerMeta,
  type Address,
  type GetAccountInfoApi,
  type Instruction,
  type MaybeEncodedAccount,
  type Rpc,
  type TransactionSigner,
} from "@solana/kit";
import { ByteReader, ByteWriter, bytesEqual } from "./bytes.js";
import { SYSTEM_PROGRAM_ADDRESS } from "./squads.js";

/** The SPL Record program (mainnet and devnet). */
export const RECORD_PROGRAM_ADDRESS = address(
  "recr1L3PCGKLbckBqMNcJhuuyU1zgo8nBhfLVsJNwr5",
);
/** Record account header: version (1) and authority. */
export const RECORD_HEADER_SIZE = 1 + 32;
/**
 * Bytes per `Write`, so each upload transaction stays under 1,232 bytes with
 * compute budget instructions and a separate fee payer.
 */
export const STORAGE_CHUNK_SIZE = 768;
export const MAX_RECORD_SIZE = 10 * 1024 * 1024 - RECORD_HEADER_SIZE;
/** Seed of the owner's pointer, `createWithSeed(owner, POINTER_SEED, Record)`. */
export const POINTER_SEED = "key-record-pointer";
/** `SKRPTR02`, current record, data hash. */
export const POINTER_DATA_SIZE = 8 + 32 + 32;

const RECORD_VERSION = 1;
const RECORD_INITIALIZE = 0;
const RECORD_WRITE = 1;
const RECORD_SET_AUTHORITY = 2;
const RECORD_CLOSE = 3;
const SYSTEM_CREATE_ACCOUNT = 0;
const SYSTEM_TRANSFER = 2;
const SYSTEM_ALLOCATE_WITH_SEED = 9;
const SYSTEM_ASSIGN_WITH_SEED = 10;
const addressEncoder = getAddressEncoder();
const addressDecoder = getAddressDecoder();
const utf8 = new TextEncoder();
const POINTER_MAGIC = utf8.encode("SKRPTR02");

/** What the owner's pointer says about its current record. */
export interface StoragePointer {
  readonly current: Address;
  /** SHA-256 of the current record's bytes. */
  readonly dataHash: Uint8Array;
}

export interface RecordUpload {
  /** The new record account. */
  readonly address: Address;
  /**
   * Send each entry as its own transaction, in order. The first creates the
   * record, the last hands its authority to the owner and freezes the bytes.
   */
  readonly transactions: readonly (readonly Instruction[])[];
  /**
   * Cancels the upload before its last transaction: the payer signs and gets
   * the rent back. Afterwards only the owner can close it.
   */
  readonly closeInstruction: Instruction;
}

/** The current published record of an owner, read through its pointer. */
export interface PublishedRecord {
  readonly address: Address;
  readonly bytes: Uint8Array;
}

/** Any `@solana/kit` RPC that can read accounts. */
export type StorageRpc = Rpc<GetAccountInfoApi>;

/** The rent-exempt minimum for `space` bytes at the default rent rate. */
export function rentExemptLamports(space: number): bigint {
  return BigInt(space + 128) * 6960n;
}

export function storagePointerAddress(owner: Address): Promise<Address> {
  return createAddressWithSeed({
    baseAddress: owner,
    programAddress: RECORD_PROGRAM_ADDRESS,
    seed: POINTER_SEED,
  });
}

/** SHA-256 of the record bytes; the pointer stores it. */
export function storageDataHash(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(createHash("sha256").update(bytes).digest());
}

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

export function encodeStoragePointer(pointer: StoragePointer): Uint8Array {
  return new ByteWriter()
    .bytes(POINTER_MAGIC)
    .bytes(addressEncoder.encode(pointer.current))
    .bytes(pointer.dataHash)
    .finish();
}

export function decodeStoragePointer(data: Uint8Array): StoragePointer {
  const reader = new ByteReader(data, "storage pointer");
  if (!bytesEqual(reader.bytes(8, "magic"), POINTER_MAGIC)) {
    throw new Error("not a storage pointer");
  }
  const current = addressDecoder.decode(reader.bytes(32, "current record"));
  const dataHash = reader.bytes(32, "data hash");
  reader.end();
  return { current, dataHash };
}

/** Reads at `confirmed`, so a record published in a confirmed transaction is visible. */
function fetchAccount(
  rpc: StorageRpc,
  account: Address,
): Promise<MaybeEncodedAccount> {
  return fetchEncodedAccount(rpc, account, { commitment: "confirmed" });
}

/** A Record account whose authority is `authority`, or an error. */
async function fetchRecordData(
  rpc: StorageRpc,
  account: Address,
  authority: Address,
  label: string,
): Promise<Uint8Array> {
  const fetched = await fetchAccount(rpc, account);
  if (!fetched.exists || fetched.programAddress !== RECORD_PROGRAM_ADDRESS) {
    throw new Error(`missing ${label} or not a Record account`);
  }
  const decoded = decodeRecordAccount(fetched.data);
  if (decoded.authority !== authority) {
    throw new Error(`${label} is not controlled by ${authority}`);
  }
  return decoded.data;
}

export async function fetchStoragePointer(
  rpc: StorageRpc,
  owner: Address,
): Promise<StoragePointer | undefined> {
  const account = await fetchAccount(rpc, await storagePointerAddress(owner));
  if (!account.exists || account.programAddress !== RECORD_PROGRAM_ADDRESS) {
    return undefined;
  }
  const decoded = decodeRecordAccount(account.data);
  if (decoded.authority !== owner) {
    throw new Error(`storage pointer is not controlled by ${owner}`);
  }
  return decodeStoragePointer(decoded.data);
}

/**
 * `owner`'s current published record, or undefined before its first
 * publication. The record must be frozen under the owner and hash to the
 * pointer's data hash; anything else is an invalid state.
 */
export async function fetchPublishedRecord(
  rpc: StorageRpc,
  owner: Address,
): Promise<PublishedRecord | undefined> {
  const pointer = await fetchStoragePointer(rpc, owner);
  if (pointer === undefined) return undefined;
  const bytes = await fetchRecordData(
    rpc,
    pointer.current,
    owner,
    "current record",
  );
  if (!bytesEqual(storageDataHash(bytes), pointer.dataHash)) {
    throw new Error("the current record does not match its pointer's hash");
  }
  return { address: pointer.current, bytes };
}

function recordInstruction(
  accounts: readonly AccountMeta[],
  data: Uint8Array,
): Instruction {
  return { programAddress: RECORD_PROGRAM_ADDRESS, accounts, data };
}

function recordInitialize(record: Address, authority: Address): Instruction {
  return recordInstruction(
    [
      { address: record, role: AccountRole.WRITABLE },
      { address: authority, role: AccountRole.READONLY },
    ],
    Uint8Array.of(RECORD_INITIALIZE),
  );
}

function recordWrite(
  record: Address,
  authority: AccountMeta,
  offset: number,
  bytes: Uint8Array,
): Instruction {
  return recordInstruction(
    [{ address: record, role: AccountRole.WRITABLE }, authority],
    new ByteWriter()
      .u8(RECORD_WRITE)
      .u64(BigInt(offset))
      .u32(bytes.length)
      .bytes(bytes)
      .finish(),
  );
}

function recordSetAuthority(
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
    Uint8Array.of(RECORD_SET_AUTHORITY),
  );
}

function recordClose(
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
    Uint8Array.of(RECORD_CLOSE),
  );
}

function systemInstruction(
  accounts: readonly AccountMeta[],
  data: Uint8Array,
): Instruction {
  return { programAddress: SYSTEM_PROGRAM_ADDRESS, accounts, data };
}

/** bincode `String`: u64 length, then UTF-8 bytes. */
function seedBytes(seed: string): Uint8Array {
  const bytes = utf8.encode(seed);
  return new ByteWriter().u64(BigInt(bytes.length)).bytes(bytes).finish();
}

/**
 * Upload separately; publication requires the owner. `payer` funds the record
 * and signs every transaction. The payer gets the rent back only by cancelling
 * the upload before its last transaction; once a later publication replaces
 * the record, its rent goes to the owner.
 */
export async function prepareRecordUpload(
  input: Readonly<{
    owner: Address;
    payer: TransactionSigner;
    bytes: Uint8Array;
  }>,
): Promise<RecordUpload> {
  if (input.bytes.length === 0 || input.bytes.length > MAX_RECORD_SIZE) {
    throw new Error(
      "record length must be between 1 byte and the account limit",
    );
  }
  const record = await generateKeyPairSigner();
  const payer = {
    address: input.payer.address,
    role: AccountRole.WRITABLE_SIGNER,
    signer: input.payer,
  } satisfies AccountSignerMeta;
  // The payer is the record's authority until the last transaction.
  const authority = {
    address: input.payer.address,
    role: AccountRole.READONLY_SIGNER,
    signer: input.payer,
  } satisfies AccountSignerMeta;
  const space = RECORD_HEADER_SIZE + input.bytes.length;
  const transactions: Instruction[][] = [
    [
      systemInstruction(
        [
          payer,
          {
            address: record.address,
            role: AccountRole.WRITABLE_SIGNER,
            signer: record,
          } satisfies AccountSignerMeta,
        ],
        new ByteWriter()
          .u32(SYSTEM_CREATE_ACCOUNT)
          .u64(rentExemptLamports(space))
          .u64(BigInt(space))
          .bytes(addressEncoder.encode(RECORD_PROGRAM_ADDRESS))
          .finish(),
      ),
      recordInitialize(record.address, input.payer.address),
    ],
  ];
  for (
    let offset = 0;
    offset < input.bytes.length;
    offset += STORAGE_CHUNK_SIZE
  ) {
    const chunk = input.bytes.subarray(offset, offset + STORAGE_CHUNK_SIZE);
    transactions.push([recordWrite(record.address, authority, offset, chunk)]);
  }
  // Handing the authority to the owner freezes the bytes for approval.
  transactions
    .at(-1)
    ?.push(recordSetAuthority(record.address, authority, input.owner));
  return {
    address: record.address,
    transactions,
    closeInstruction: recordClose(
      record.address,
      authority,
      input.payer.address,
    ),
  };
}

/**
 * Throws unless `upload` is complete, frozen under `owner` and holds exactly
 * `bytes`. Approvers run this before co-signing a publication: once the owner
 * is the authority only the owner can change the bytes, so what they checked
 * is what gets published.
 */
export async function checkUploadedRecord(
  rpc: StorageRpc,
  owner: Address,
  upload: Address,
  bytes: Uint8Array,
): Promise<void> {
  const uploaded = await fetchRecordData(rpc, upload, owner, "uploaded record");
  if (!bytesEqual(uploaded, bytes)) {
    throw new Error("the uploaded record does not hold the approved bytes");
  }
}

/**
 * The owner's publication of an uploaded record: the instructions it signs in
 * one transaction. The first publication creates the pointer; a replacement
 * rewrites it and closes `predecessor`, the record it replaces, whose rent
 * goes to the owner. The pointer records the hash of `bytes`, so readers
 * reject anything else; approvers run `checkUploadedRecord` first.
 *
 * The instructions depend only on the input, so an approver can build them
 * again and compare them with what it is asked to sign. The Record program
 * rejects the transaction unless the upload is frozen under the owner. A
 * first publication fails if the pointer exists, and a replacement fails if
 * `predecessor` is no longer a record of the owner, which stops a stale or
 * repeated publication.
 */
export async function publishRecordInstructions(
  input: Readonly<{
    owner: Address;
    /** The uploaded record account to publish. */
    upload: Address;
    /** The current published record, undefined for the first publication. */
    predecessor: Address | undefined;
    bytes: Uint8Array;
  }>,
): Promise<Instruction[]> {
  const { owner, upload, predecessor, bytes } = input;
  if (predecessor === upload) {
    throw new Error("cannot replace a record with itself");
  }
  const ownerSigner = { address: owner, role: AccountRole.READONLY_SIGNER };
  const pointer = await storagePointerAddress(owner);
  const pointerData = encodeStoragePointer({
    current: upload,
    dataHash: storageDataHash(bytes),
  });
  // Setting the upload's authority to the owner it must already have changes
  // nothing, but the Record program rejects it unless the upload exists, is
  // initialized and is controlled by the owner. A publication therefore
  // cannot name a missing record or one its payer can still rewrite or close.
  const frozenCheck = recordSetAuthority(upload, ownerSigner, owner);
  if (predecessor !== undefined) {
    return [
      frozenCheck,
      recordWrite(pointer, ownerSigner, 0, pointerData),
      recordClose(predecessor, ownerSigner, owner),
    ];
  }
  // Transfer, allocate and assign instead of create, so lamports someone sent
  // to the pointer address cannot block the first publication. The transfer
  // is the full rent: reading the pointer's balance first would make the
  // instructions depend on an RPC read. Allocate fails if the pointer exists.
  const space = RECORD_HEADER_SIZE + POINTER_DATA_SIZE;
  const fundingOwner = { address: owner, role: AccountRole.WRITABLE_SIGNER };
  const seeded = [
    { address: pointer, role: AccountRole.WRITABLE },
    ownerSigner,
  ];
  const seed = seedBytes(POINTER_SEED);
  const ownerBytes = addressEncoder.encode(owner);
  const programBytes = addressEncoder.encode(RECORD_PROGRAM_ADDRESS);
  return [
    systemInstruction(
      [fundingOwner, { address: pointer, role: AccountRole.WRITABLE }],
      new ByteWriter()
        .u32(SYSTEM_TRANSFER)
        .u64(rentExemptLamports(space))
        .finish(),
    ),
    systemInstruction(
      seeded,
      new ByteWriter()
        .u32(SYSTEM_ALLOCATE_WITH_SEED)
        .bytes(ownerBytes)
        .bytes(seed)
        .u64(BigInt(space))
        .bytes(programBytes)
        .finish(),
    ),
    systemInstruction(
      seeded,
      new ByteWriter()
        .u32(SYSTEM_ASSIGN_WITH_SEED)
        .bytes(ownerBytes)
        .bytes(seed)
        .bytes(programBytes)
        .finish(),
    ),
    recordInitialize(pointer, owner),
    frozenCheck,
    recordWrite(pointer, ownerSigner, 0, pointerData),
  ];
}
