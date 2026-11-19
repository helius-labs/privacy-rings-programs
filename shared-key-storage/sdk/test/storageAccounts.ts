/** Fake storage-program accounts for unit tests that read through a client. */
import { getAddressEncoder, type Address } from "@solana/kit";
import type { SprClient } from "@heliuslabs/spr/client";
import { ByteWriter } from "../src/bytes.js";
import {
  STORAGE_PROGRAM_ADDRESS,
  storageDataHash,
  storageHeadAddress,
  type StorageRpc,
} from "../src/storage.js";

export type FakeAccounts = Map<Address, { owner: Address; data: Uint8Array }>;

const addressEncoder = getAddressEncoder();
const utf8 = new TextEncoder();

/** A storage buffer account: header, then the uploaded bytes. */
export function storedBytes(
  input: Readonly<{
    owner: Address;
    payer: Address;
    /** The payer unless given. */
    refund?: Address;
    previous: Address;
    bytes: Uint8Array;
    sealed?: number;
    totalLength?: number;
  }>,
): Uint8Array {
  return new ByteWriter()
    .bytes(utf8.encode("STORBUF1"))
    .u8(input.sealed ?? 1)
    .bytes(addressEncoder.encode(input.owner))
    .bytes(addressEncoder.encode(input.payer))
    .bytes(addressEncoder.encode(input.refund ?? input.payer))
    .bytes(addressEncoder.encode(input.previous))
    .u32(input.totalLength ?? input.bytes.length)
    .bytes(storageDataHash(input.bytes))
    .bytes(input.bytes)
    .finish();
}

export function headBytes(current: Address, revision = 1n): Uint8Array {
  return new ByteWriter()
    .bytes(utf8.encode("STORHEAD"))
    .bytes(addressEncoder.encode(current))
    .u64(revision)
    .finish();
}

/** An RPC whose `getAccountInfo` reads from `accounts`. */
export function accountRpc(accounts: FakeAccounts): StorageRpc {
  return {
    getAccountInfo: (address: Address) => ({
      send: async () => {
        const account = accounts.get(address);
        return {
          context: { slot: 0n },
          value:
            account === undefined
              ? null
              : {
                  data: [
                    Buffer.from(account.data).toString("base64"),
                    "base64",
                  ],
                  executable: false,
                  lamports: 1n,
                  owner: account.owner,
                  space: BigInt(account.data.length),
                },
        };
      },
    }),
  } as unknown as StorageRpc;
}

/** A client whose Solana RPC reads from `accounts`. */
export function accountClient(accounts: FakeAccounts): SprClient {
  return { solanaRpc: accountRpc(accounts) } as unknown as SprClient;
}

/** Adds `owner`'s head and the sealed record it points to. */
export async function publish(
  accounts: FakeAccounts,
  input: Readonly<{
    owner: Address;
    record: Address;
    payer: Address;
    refund?: Address;
    previous: Address;
    bytes: Uint8Array;
    revision?: bigint;
  }>,
): Promise<void> {
  accounts.set(await storageHeadAddress(input.owner), {
    owner: STORAGE_PROGRAM_ADDRESS,
    data: headBytes(input.record, input.revision),
  });
  accounts.set(input.record, {
    owner: STORAGE_PROGRAM_ADDRESS,
    data: storedBytes(input),
  });
}
