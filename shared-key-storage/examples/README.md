# Shared Key Storage examples

Two scripts that use the raw storage API of the [SDK](../sdk/). Your wallet
is the record owner, rent payer and refund destination.

### create

Creates two accounts:

- **Buffer account**: stores the record bytes. The script uploads them in
  768-byte chunks, one transaction per chunk.
- **Pointer account**: the PDA `["head", wallet]`. It stores the buffer
  address and a revision. The final transaction creates it and marks the
  buffer as sealed.

Run once per wallet. To replace the record, run `update`.

### update

Replaces the record:

- **New buffer account**: stores the new record bytes, uploaded the same
  way. The old buffer stays current until the final transaction.
- **Pointer account**: the final transaction points it at the new buffer,
  increments the revision, closes the old buffer and sends its rent to the
  old buffer's refund address. It fails if the revision changed after the
  script read it.

## Run

Use Node.js 24+ and pnpm. Build the SDK first, since the examples import its
compiled package. Fund the wallet with SOL on the selected cluster.

```bash
(cd ../sdk && pnpm install && pnpm build)
pnpm install
export SOLANA_RPC_URL='https://devnet.helius-rpc.com/?api-key=YOUR_KEY'
pnpm create-record [file]   # upload record 0 and create the head
pnpm update-record [file]   # upload a replacement, apply it, refund the old one
```

Without a file argument each script publishes a short sample text. The wallet
defaults to `~/.config/solana/id.json`; set `PAYER_KEYPAIR` to use another
file. `create-record` fails if the wallet already has a record, and `update-record` fails if
it has none.

There is no close example. The head and the current record can never be
closed, so their rent stays locked. `apply` closes and refunds each
superseded record, and an unpublished upload can be cancelled with
`closeInstruction` from `prepareRecordUpload`.
