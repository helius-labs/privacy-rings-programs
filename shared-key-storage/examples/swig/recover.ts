/**
 * Recovers the shared keys of a private Swig wallet as each of its members,
 * and reads the vault's private balance with them.
 *
 * 1. Read the vault's current key record through its storage pointer. The
 *    helper accepts it only if it belongs to this Swig, names exactly the
 *    Swig's authorities and holds the vault's registered viewing key.
 * 2. Each member decrypts its entry and gets the shared viewing key, the
 *    nullifier secret and every earlier viewing key. Assert that all of them
 *    recover the same keys and that a non-member cannot.
 * 3. Sync the vault's UTXOs with the recovered viewing keys.
 *
 * Run: pnpm swig-recover <swig>
 */
import { SOL_MINT } from "@heliuslabs/spr";
import {
  destroyVaultSecrets,
  fetchPublishedKeyRecord,
  type Member,
} from "@heliuslabs/shared-key-storage";
import { vaultKeys } from "../helpers/spend.js";
import {
  fetchSwig,
  swigMembers,
  swigVaultAddress,
} from "../helpers/swig/account.js";
import { recoverSwigVaultKeys } from "../helpers/swig/recover.js";
import {
  addressArgument,
  assertMembersRecover,
  connect,
  membersAmong,
  shieldedWallet,
} from "../common.js";

const swig = addressArgument("swig-recover", "swig");

const session = await connect();
const { client } = session;
const vault = await swigVaultAddress(swig);

// 1. The current key record.
const published = await fetchPublishedKeyRecord(client, vault);
if (published === undefined) throw new Error(`${swig} has no key record`);
console.log(
  `record:   ${published.address} (key record ${published.record.epoch})`,
);

// 2. Every member recovers the shared keys; the others cannot.
const { members, others } = membersAmong(
  session,
  swigMembers(await fetchSwig(client, swig)),
);
const recover = (member: Member) =>
  recoverSwigVaultKeys({ client, swig, member });
await assertMembersRecover({
  members,
  removed: others,
  expected: published.record,
  recover,
});

// 3. The vault's private balance, read as the last member.
const reader = members.at(-1);
if (reader === undefined) throw new Error("no example member has a role");
const recovered = await recover(reader);
const keys = vaultKeys(client, vault, recovered.secrets, recovered.viewingKeys);
try {
  const wallet = await shieldedWallet(client, keys.address, keys.shielded);
  console.log(`vault:    ${vault}`);
  console.log(
    `balance:  ${wallet.balance(SOL_MINT).amount} lamports, read by ${reader.name}`,
  );
} finally {
  keys.shielded.destroy();
  keys.proving.destroy();
  destroyVaultSecrets(recovered);
}
