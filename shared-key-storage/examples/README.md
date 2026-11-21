# Shared Key Storage examples

Scripts that run every flow of [`design.md`](../design.md) for a private
wallet with three members who share one viewing key: a Squads smart account
([`smart-account/`](smart-account/)) and a Swig wallet ([`swig/`](swig/)).
Each script works on a real key record and asserts that the members recover
the shared keys from it.

| Script    | What it does                                                                      |
| --------- | --------------------------------------------------------------------------------- |
| `create`  | Creates the wallet for Alice, Bob and Carol and publishes key record 0            |
| `rotate`  | Swaps the third member (Carol and Dave) and the shared viewing key, atomically    |
| `recover` | Recovers the keys as each member and reads the vault's private balance            |
| `spend`   | Deposits 0.01 SOL to the vault and pays a shielded recipient with the shared keys |
| `close`   | Closes the vault's key record and its pointer                                     |

Run `create` first; it prints the address the other scripts take. They can
then run in any order and any number of times, except that nothing works
after `close`: the vault stays in the user registry, so `create` cannot
publish for it again.

## Members

Alice is your wallet. It pays every fee and rent, and its shielded keypair is
derived from its secret key. Bob, Carol and Dave are derived from your
wallet's secret key too, so every script can act as each of them without
storing keys. In a real wallet they are separate people with their own keys.

`create` registers each member's own keys in the user registry, because a
rotation reads the viewing keys of the members that stay from there.

Every script ends by having each member recover the shared viewing key, the
nullifier key and one viewing key per epoch from the vault's current record,
and by checking that a member who left cannot.

### smart-account

All three are Squads signers with every permission, and the threshold is 2.
Alice and Bob approve each transaction. Before co-signing a register or a
rotation, each of them checks the frozen upload, the key history, its own
entry and the exact instructions (`checkRegistration`, `checkRotation`). The
vault signs through `executeTransactionSyncV2`; a rotation changes the signer
with `executeSettingsTransactionSync` in the same transaction.

### swig

Alice holds the root role, the view key authority, which alone publishes key
records and changes members. Bob and Carol hold member roles, which may only
spend through the shielded pool. The members check the frozen upload and
their own entries before Alice publishes. The vault, the Swig's wallet
address, signs through `SignV2`; a rotation changes the member role with
`AddAuthorityV1` and `RemoveAuthorityV1` in the same transaction. Bob spends
on his own.

## Helpers

The SDK only builds the instructions a vault signs. [`helpers/`](helpers/)
holds what a private wallet needs on top of that. It is reference code for
these examples, not a supported API:

- `helpers/smart-account/` and `helpers/swig/`: instruction encoders and
  account decoders for the two wallet programs, and the create, register,
  rotate, recover and spend flows wrapped in each wallet's own instructions.
- `helpers/spend.ts`: the SPP `transact` built and proved as the vault with
  the keys recovered from a key record.
- `helpers/cpi.ts`: the compact payload both wallet programs take for the
  inner instructions the vault signs.

## Run

Use Node.js 24+ and pnpm. The SDK and the examples are one pnpm workspace:
install once from `shared-key-storage/`, then build the SDK, since the
examples import its compiled package. Fund the wallet with about 0.1 SOL on
the selected cluster.

```bash
(cd .. && pnpm install)
(cd ../sdk && pnpm build)
export SOLANA_RPC_URL='https://devnet.helius-rpc.com/?api-key=YOUR_KEY'
pnpm smart-account-create
pnpm smart-account-rotate <settings>
pnpm smart-account-recover <settings>
pnpm smart-account-spend <settings>
pnpm smart-account-close <settings>
pnpm swig-create
pnpm swig-rotate <swig>
pnpm swig-recover <swig>
pnpm swig-spend <swig>
pnpm swig-close <swig>
```

The wallet defaults to `~/.config/solana/id.json`; set `PAYER_KEYPAIR` to use
another file.

## Tests

```bash
pnpm test                    # helper unit tests and LiteSVM Swig tests
export SOLANA_DEVNET_RPC_URL='https://devnet.helius-rpc.com/?api-key=YOUR_KEY'
export SOLANA_MAINNET_RPC_URL='https://mainnet.helius-rpc.com/?api-key=YOUR_KEY'
pnpm test:devnet             # create, register, spend and rotate on devnet
pnpm test:mainnet            # the same flows on mainnet
```

Each command builds the SDK first. The network tests run the flows for both
a Squads smart account and a Swig wallet, and are the tests that send the
SDK's instructions in whole transactions. They need only the selected
network's RPC URL, and check the cluster's genesis hash and deployed
programs before funding accounts. The payer defaults to
`~/.config/solana/id.json` (override with `ZOLANA_PAYER_KEYPAIR`) and needs
at least 0.1 SOL.

The Swig tests run in LiteSVM against the Swig binary dumped from mainnet. To
refresh it:

```bash
solana program dump swigypWHEksbC64pWKwah1WTeh9JXwx8H1rJHLdbQMB test/fixtures/swig.so -u mainnet-beta
```
