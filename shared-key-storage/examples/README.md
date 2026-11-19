# Shared Key Storage examples

Two scripts that use the raw storage API of the [SDK](../sdk/). Your wallet
is the record owner, rent payer and refund destination.

| Script      | What it does                                                                                       |
| ----------- | -------------------------------------------------------------------------------------------------- |
| `create.ts` | Uploads record 0 in chunks, then applies it, which creates the head PDA `[b"head", wallet]`.       |
| `update.ts` | Uploads a replacement, applies it against the current revision, and refunds the old record's rent. |

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
