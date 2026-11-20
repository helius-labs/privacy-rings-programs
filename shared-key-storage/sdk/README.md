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
