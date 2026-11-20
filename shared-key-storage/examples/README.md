# Shared Key Storage examples

Two scripts that use the raw storage API of the [SDK](../sdk/). Records are
stored in accounts of the SPL Record program; there is no custom program.
Your wallet is the record owner and the rent payer.

### create

Creates two Record accounts:

- **Record account**: stores the record bytes. The script creates it at full
  size, writes the bytes in 768-byte chunks, one transaction per chunk, and
  then hands its authority to the wallet, which freezes the bytes.
- **Pointer account**: a Record account at a seeded address,
  `createWithSeed(wallet, "key-record-pointer", Record)`. It stores the
  record's address and the SHA-256 of its bytes. The final transaction
  creates it.

Run once per wallet. To replace the record, run `update`.

### update

Replaces the record:

- **New record account**: stores the new record bytes, uploaded and frozen
  the same way. The old record stays current until the final transaction.
- **Pointer account**: the final transaction writes the new record's address
  and hash into it, closes the old record and sends its rent to the wallet.

The Record program rejects the final transaction unless the new record is
frozen under the wallet and the old record it closes is still open.

## Run

Use Node.js 24+ and pnpm. Build the SDK first, since the examples import its
compiled package. Fund the wallet with SOL on the selected cluster.

```bash
(cd ../sdk && pnpm install && pnpm build)
pnpm install
export SOLANA_RPC_URL='https://devnet.helius-rpc.com/?api-key=YOUR_KEY'
pnpm create-record [file]   # upload record 0 and create the pointer
pnpm update-record [file]   # upload a replacement, publish it, close the old one
```

Without a file argument each script publishes a short sample text. The wallet
defaults to `~/.config/solana/id.json`; set `PAYER_KEYPAIR` to use another
file. `create-record` fails if the wallet already has a record, and
`update-record` fails if it has none.

There is no close example. A publication closes the record it replaces, and
an upload can be cancelled with `closeInstruction` from `prepareRecordUpload`
until its last transaction hands the authority to the wallet. The wallet, as the authority, can close its pointer and current
record with the Record program's `CloseAccount`.
