/**
 * Recovers the shared keys of a private Squads smart account as each of its
 * members, and reads the vault's private balance with them.
 *
 * 1. Read the vault's current key record through its storage pointer. The
 *    helper accepts it only if it belongs to this account, names exactly the
 *    Squads signers and holds the vault's registered viewing key.
 * 2. Each member decrypts its entry and gets the shared viewing key, the
 *    nullifier secret and every earlier viewing key. Assert that all of them
 *    recover the same keys and that a non-member cannot.
 * 3. Sync the vault's UTXOs with the recovered viewing keys.
 *
 * Run: pnpm smart-account-recover <settings>
 */
import { SOL_MINT } from "@heliuslabs/spr";
import {
  destroyVaultSecrets,
  fetchPublishedKeyRecord,
  type Member,
} from "@heliuslabs/shared-key-storage";
import { fetchSettings } from "../helpers/smart-account/account.js";
import { vaultAddress } from "../helpers/smart-account/program.js";
import { recoverVaultKeys } from "../helpers/smart-account/recover.js";
import { vaultKeys } from "../helpers/spend.js";
import {
  addressArgument,
  assertMembersRecover,
  connect,
  membersAmong,
  shieldedWallet,
} from "../common.js";

const settings = addressArgument("smart-account-recover", "settings");

const session = await connect();
const { client } = session;
const vault = await vaultAddress(settings);

// 1. The current key record.
const published = await fetchPublishedKeyRecord(client, vault);
if (published === undefined) throw new Error(`${settings} has no key record`);
console.log(
  `record:   ${published.address} (key record ${published.record.epoch})`,
);

// 2. Every member recovers the shared keys; the others cannot.
const { members, others } = membersAmong(
  session,
  (await fetchSettings(client, settings)).signers.map((signer) => signer.key),
);
const recover = (member: Member) =>
  recoverVaultKeys({ client, settings, member });
await assertMembersRecover({
  members,
  removed: others,
  expected: published.record,
  recover,
});

// 3. The vault's private balance, read as the first member.
const [reader] = members;
if (reader === undefined) throw new Error("no example member is a signer");
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
