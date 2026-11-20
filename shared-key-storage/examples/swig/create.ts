/**
 * Creates a Swig wallet and publishes its first record. The Swig's wallet
 * address owns the record; your wallet is the Swig's view key authority (its
 * root role) and pays for everything.
 *
 * 1. Create the Swig with your wallet as root, and fund its wallet address,
 *    which pays the pointer's rent.
 * 2. Upload: create a Record account, write the bytes in chunks, then hand
 *    its authority to the Swig's wallet address, which freezes the bytes.
 * 3. Publish: the root role's `SignV2` has the wallet address create its
 *    pointer and write the record's address and hash into it.
 *
 * Run: pnpm swig-create [file]
 */
import {
  checkUploadedRecord,
  createSwigInstruction,
  fetchPublishedRecord,
  prepareRecordUpload,
  publishRecordInstructions,
  signV2Instruction,
  storagePointerAddress,
  swigAddress,
  swigVaultAddress,
  viewKeyAuthorityActions,
  VIEW_KEY_AUTHORITY_ROLE,
} from "@heliuslabs/shared-key-storage";
import {
  recordBytes,
  send,
  setup,
  transferSol,
  upload,
  SWIG_BUDGET,
} from "../common.js";

const { rpc, wallet } = await setup();
const bytes = await recordBytes(
  `Swig record 0, created ${new Date().toISOString()}`,
  process.argv[2],
);

const id = crypto.getRandomValues(new Uint8Array(32));
const swig = (await swigAddress(id)).address;
const vault = await swigVaultAddress(swig);
const create = await createSwigInstruction({
  payer: wallet,
  id,
  authority: wallet.address,
  actions: viewKeyAuthorityActions(SWIG_BUDGET),
});
console.log(
  `created Swig ${swig}: ${await send(rpc, wallet, [
    create,
    transferSol(wallet, vault, 10_000_000n),
  ])}`,
);

const prepared = await prepareRecordUpload({
  owner: vault,
  payer: wallet,
  bytes,
});
console.log(`uploading ${bytes.length} bytes to ${prepared.address}`);
await upload(rpc, wallet, prepared.transactions);

// Check the frozen upload, then publish it as the Swig's wallet address.
await checkUploadedRecord(rpc, vault, prepared.address, bytes);
const publish = await signV2Instruction({
  swig,
  roleId: VIEW_KEY_AUTHORITY_ROLE,
  authority: wallet,
  inner: await publishRecordInstructions({
    owner: vault,
    upload: prepared.address,
    predecessor: undefined,
    bytes,
  }),
});
console.log(`published: ${await send(rpc, wallet, [publish])}`);

const published = await fetchPublishedRecord(rpc, vault);
if (published === undefined) throw new Error("record was not published");
console.log(`swig:     ${swig}`);
console.log(`vault:    ${vault}`);
console.log(`pointer:  ${await storagePointerAddress(vault)}`);
console.log(`record:   ${published.address}`);
console.log(`content:  ${new TextDecoder().decode(published.bytes)}`);
console.log(`next:     pnpm swig-rotate ${swig} add <member address>`);
