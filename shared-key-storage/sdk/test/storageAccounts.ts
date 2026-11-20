/** Fake Record-program accounts for unit tests that read through a client. */
import { getAddressEncoder, type Address } from "@solana/kit";
import type { SprClient } from "@heliuslabs/spr/client";
import { ByteWriter } from "../src/bytes.js";
import {
  RECORD_PROGRAM_ADDRESS,
  encodeStoragePointer,
  storageDataHash,
  storagePointerAddress,
  type StorageRpc,
} from "../src/storage.js";

export type FakeAccounts = Map<
  Address,
  { owner: Address; data: Uint8Array; executable?: boolean }
>;

const addressEncoder = getAddressEncoder();

/** A Record account: version 1, `authority`, then `data`. */
export function recordAccountBytes(
  authority: Address,
  data: Uint8Array,
): Uint8Array {
  return new ByteWriter()
    .u8(1)
    .bytes(addressEncoder.encode(authority))
    .bytes(data)
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
                  executable: account.executable ?? false,
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

/** Adds an upload of `bytes` at `record`, frozen under `owner`. */
export function upload(
  accounts: FakeAccounts,
  input: Readonly<{ owner: Address; record: Address; bytes: Uint8Array }>,
): void {
  accounts.set(input.record, {
    owner: RECORD_PROGRAM_ADDRESS,
    data: recordAccountBytes(input.owner, input.bytes),
  });
}

/** Adds `owner`'s pointer and the published record it names. */
export async function publish(
  accounts: FakeAccounts,
  input: Readonly<{
    owner: Address;
    record: Address;
    bytes: Uint8Array;
  }>,
): Promise<void> {
  upload(accounts, input);
  accounts.set(await storagePointerAddress(input.owner), {
    owner: RECORD_PROGRAM_ADDRESS,
    data: recordAccountBytes(
      input.owner,
      encodeStoragePointer({
        current: input.record,
        dataHash: storageDataHash(input.bytes),
      }),
    ),
  });
}
