# Shared Key Storage SDK

`@heliuslabs/shared-key-storage` is a Node.js TypeScript SDK for uploading
and reading encrypted key records, stored in SPL Record accounts, and for
creating, registering, rotating and
spending from private Squads smart accounts.

Use Node.js 24+ and run `pnpm install`, then `pnpm build` from this directory.
Run `pnpm pack` to build a tarball for local installation in another project.

```ts
import { storagePointerAddress } from "@heliuslabs/shared-key-storage";
import type { Address } from "@solana/kit";

export async function findVaultStoragePointer(vault: Address) {
  return storagePointerAddress(vault);
}
```

## Tests

```bash
pnpm test                    # unit tests and LiteSVM storage tests
export SOLANA_DEVNET_RPC_URL='https://devnet.helius-rpc.com/?api-key=YOUR_KEY'
export SOLANA_MAINNET_RPC_URL='https://mainnet.helius-rpc.com/?api-key=YOUR_KEY'
pnpm test:devnet             # create, register, spend and rotate on devnet
pnpm test:mainnet            # the same flows on mainnet
```

The network tests need only the selected network's RPC URL. They check the
cluster's genesis hash and deployed programs before funding accounts. The
payer defaults to `~/.config/solana/id.json` (override with
`ZOLANA_PAYER_KEYPAIR`) and needs at least 0.1 SOL.

The storage tests run in LiteSVM against the SPL Record binary dumped from
mainnet. To refresh it:

```bash
solana program dump recr1L3PCGKLbckBqMNcJhuuyU1zgo8nBhfLVsJNwr5 test/fixtures/spl_record.so -u mainnet-beta
```
