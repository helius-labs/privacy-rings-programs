# Shared Key Storage SDK

`@heliuslabs/shared-key-storage` is a Node.js TypeScript SDK for encrypted
key records stored in SPL Record accounts. It covers four operations:

| Operation | Functions                                                                   |
| --------- | --------------------------------------------------------------------------- |
| Create    | `createKeyRecord`, `prepareKeyRecordUpload`, `createKeyRecordInstructions`  |
| Update    | `rotatedKeyRecord`, `prepareKeyRecordUpload`, `updateKeyRecordInstructions` |
| Remove    | `removeRecordInstructions`                                                  |
| Recover   | `fetchCurrentKeyRecord`, `recoverRecordKeys`                                |

The vault that owns a record is usually a PDA of a wallet program. Create,
update and remove return the instructions the vault signs; wrap them in the
wallet program's own instruction. They depend only on their input, so an
approver can build them again and compare them with what it is asked to sign
(`checkProposedKeyRecord`, `checkEntryOpens`, `checkInstructionsMatch`).

An update that changes who can read the key belongs in the same transaction
as the wallet's signer change; the SDK does not build that part.

The [examples](../examples/) wrap these instructions for Squads smart
accounts and Swig wallets, and show how to spend from the vault with the
recovered keys.

Use Node.js 24+. Run `pnpm install` from `shared-key-storage/`, which installs
the SDK and the examples as one workspace, then `pnpm build` from this
directory. Run `pnpm pack` to build a tarball for local installation in
another project; it needs `@heliuslabs/spr` and `@solana/kit` installed next
to it, as peer dependencies, so the project and the SDK share one copy of
each.

```ts
import { storagePointerAddress } from "@heliuslabs/shared-key-storage";
import type { Address } from "@solana/kit";

export async function findVaultStoragePointer(vault: Address) {
  return storagePointerAddress(vault);
}
```

## Tests

```bash
pnpm test    # unit tests and LiteSVM storage tests
```

The storage tests run in LiteSVM against the SPL Record binary dumped from
mainnet. To refresh it:

```bash
solana program dump recr1L3PCGKLbckBqMNcJhuuyU1zgo8nBhfLVsJNwr5 test/fixtures/spl_record.so -u mainnet-beta
```

The tests that send whole transactions on devnet or mainnet need a wallet
program to sign for the vault, so they live with the
[examples](../examples/#tests).
