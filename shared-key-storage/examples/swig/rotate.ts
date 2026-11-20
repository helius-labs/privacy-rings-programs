/**
 * Adds or removes a Swig member and replaces the Swig's record, in one
 * transaction. Your wallet must be the Swig's view key authority (root role).
 * Members can only spend through the shielded pool; they cannot write the
 * record or change membership.
 *
 * 1. Upload the new bytes into a fresh Record account, frozen under the
 *    Swig's wallet address. The current record stays published meanwhile.
 * 2. One transaction: the root role's `SignV2` points the pointer at the new
 *    record and closes the old one, whose rent goes to the wallet address;
 *    then `AddAuthorityV1` or `RemoveAuthorityV1` changes the member.
 *
 * Run: pnpm swig-rotate <swig> add|remove <member address> [file]
 */
import { address } from "@solana/kit";
import {
  addAuthorityInstruction,
  checkUploadedRecord,
  decodeSwig,
  fetchPublishedRecord,
  memberActions,
  prepareRecordUpload,
  publishRecordInstructions,
  removeAuthorityInstruction,
  signV2Instruction,
  swigRoleOf,
  swigVaultAddress,
  VIEW_KEY_AUTHORITY_ROLE,
  type SwigAccount,
} from "@heliuslabs/shared-key-storage";
import {
  accountData,
  recordBytes,
  send,
  setup,
  upload,
  SWIG_BUDGET,
} from "../common.js";

const [swigArgument, action, memberArgument, file] = process.argv.slice(2);
if (
  swigArgument === undefined ||
  (action !== "add" && action !== "remove") ||
  memberArgument === undefined
) {
  throw new Error("usage: pnpm swig-rotate <swig> add|remove <member> [file]");
}
const swig = address(swigArgument);
const member = address(memberArgument);

function printRoles(decoded: SwigAccount): void {
  for (const role of decoded.roles) {
    console.log(`  role ${role.id}: ${role.authority ?? "(not Ed25519)"}`);
  }
}

const { rpc, wallet } = await setup();
const before = decodeSwig(await accountData(rpc, swig));
if (swigRoleOf(before, wallet.address)?.id !== VIEW_KEY_AUTHORITY_ROLE) {
  throw new Error(`${wallet.address} is not the Swig's view key authority`);
}
const memberRole = swigRoleOf(before, member);
if (action === "add" && memberRole !== undefined) {
  throw new Error(`${member} already has role ${memberRole.id}`);
}
if (action === "remove" && memberRole === undefined) {
  throw new Error(`${member} has no role`);
}
if (memberRole?.id === VIEW_KEY_AUTHORITY_ROLE) {
  throw new Error("the view key authority cannot be removed");
}

const vault = await swigVaultAddress(swig);
const current = await fetchPublishedRecord(rpc, vault);
if (current === undefined) {
  throw new Error(`${swig} has no record; run pnpm swig-create`);
}
console.log(`current:  ${current.address}`);

const bytes = await recordBytes(
  `Swig record after ${action} ${member}, ${new Date().toISOString()}`,
  file,
);
const prepared = await prepareRecordUpload({
  owner: vault,
  payer: wallet,
  bytes,
});
console.log(`uploading ${bytes.length} bytes to ${prepared.address}`);
await upload(rpc, wallet, prepared.transactions);
await checkUploadedRecord(rpc, vault, prepared.address, bytes);

const publish = await signV2Instruction({
  swig,
  roleId: VIEW_KEY_AUTHORITY_ROLE,
  authority: wallet,
  inner: await publishRecordInstructions({
    owner: vault,
    upload: prepared.address,
    predecessor: current.address,
    bytes,
  }),
});
const membership =
  memberRole === undefined
    ? addAuthorityInstruction({
        swig,
        payer: wallet,
        authority: wallet,
        actingRoleId: VIEW_KEY_AUTHORITY_ROLE,
        newAuthority: member,
        actions: memberActions(SWIG_BUDGET),
      })
    : removeAuthorityInstruction({
        swig,
        payer: wallet,
        authority: wallet,
        actingRoleId: VIEW_KEY_AUTHORITY_ROLE,
        roleId: memberRole.id,
      });
console.log(`rotated: ${await send(rpc, wallet, [publish, membership])}`);

const published = await fetchPublishedRecord(rpc, vault);
if (published === undefined) throw new Error("record was not published");
console.log(`record:   ${published.address}`);
console.log(`content:  ${new TextDecoder().decode(published.bytes)}`);
console.log("roles:");
printRoles(decodeSwig(await accountData(rpc, swig)));
