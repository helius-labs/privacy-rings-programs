# Shared Key Storage SDK

`@heliuslabs/shared-key-storage` is a Node.js TypeScript SDK for uploading
and reading encrypted key records, stored in SPL Record accounts, and for
creating, registering, rotating and spending from private Squads smart
accounts and Swig wallets.

Use Node.js 24+. Run `pnpm install` from `shared-key-storage/`, which installs
the SDK and the [examples](../examples/) as one workspace, then `pnpm build`
from this directory. Run `pnpm pack` to build a tarball for local
installation in another project; it needs `@heliuslabs/spr` and
`@solana/kit` installed next to it, as peer dependencies, so the project and
the SDK share one copy of each.

```ts
import { storagePointerAddress } from "@heliuslabs/shared-key-storage";
import type { Address } from "@solana/kit";

export async function findVaultStoragePointer(vault: Address) {
  return storagePointerAddress(vault);
}
```

## Tests

```bash
pnpm test                    # unit tests and LiteSVM storage and Swig tests
export SOLANA_DEVNET_RPC_URL='https://devnet.helius-rpc.com/?api-key=YOUR_KEY'
export SOLANA_MAINNET_RPC_URL='https://mainnet.helius-rpc.com/?api-key=YOUR_KEY'
pnpm test:devnet             # create, register, spend and rotate on devnet
pnpm test:mainnet            # the same flows on mainnet
```

The network tests run the flows for both a Squads smart account and a Swig
wallet.

The network tests need only the selected network's RPC URL. They check the
cluster's genesis hash and deployed programs before funding accounts. The
payer defaults to `~/.config/solana/id.json` (override with
`ZOLANA_PAYER_KEYPAIR`) and needs at least 0.1 SOL.

The storage and Swig tests run in LiteSVM against the SPL Record and Swig
binaries dumped from mainnet. To refresh them:

```bash
solana program dump recr1L3PCGKLbckBqMNcJhuuyU1zgo8nBhfLVsJNwr5 test/fixtures/spl_record.so -u mainnet-beta
solana program dump swigypWHEksbC64pWKwah1WTeh9JXwx8H1rJHLdbQMB test/fixtures/swig.so -u mainnet-beta
```
