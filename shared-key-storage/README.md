# Shared Key Storage

A Squads smart account whose vault holds private balances in the zolana
shielded pool (SPP), shared by all of the account's signers. A Swig wallet
works too, with one view key authority managing the keys and members that
can each spend.

**Why:** private balances are only visible to whoever holds the viewing key.
For a multisig, every signer needs that key, and it has to change when the
signer set changes, without losing access to older balances.

**What:** the signers share one viewing key. They encrypt it, and every
previous one, to each other in a key record. Each rotation publishes a new
record. Records live in accounts of the SPL Record program, so there is no
custom program. A pointer account per vault names the current record.

> [!WARNING]
> **Not for production.** Unaudited example code, and the SPL Record program
> it uses is unaudited too. Nothing checks on chain that a key record opens
> for every signer.

| Path                     | Contents                                                |
| ------------------------ | ------------------------------------------------------- |
| [`design.md`](design.md) | Flows, key record format and limitations                |
| [`sdk/`](sdk/)           | TypeScript SDK, tests and how to run them               |
| [`examples/`](examples/) | Squads and Swig scripts that create and rotate a record |
