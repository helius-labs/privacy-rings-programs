/**
 * Swig in LiteSVM against the binary dumped from mainnet
 * (`test/fixtures/swig.so`; devnet runs the same code). A Swig wallet address
 * owns key records: its view key authority publishes them through `SignV2`,
 * and a member role without Record permission cannot.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import {
  AccountRole,
  lamports,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import { ByteWriter } from "../../src/bytes.js";
import { SYSTEM_PROGRAM_ADDRESS } from "../../src/cpi.js";
import {
  fetchPublishedRecord,
  prepareRecordUpload,
  publishRecordInstructions,
} from "../../src/record/storage.js";
import { RECORD_PROGRAM_ADDRESS } from "../../src/record/program.js";
import {
  SwigPermission,
  addAuthorityInstruction,
  createSwigInstruction,
  decodeSwig,
  encodeSwigActions,
  removeAuthorityInstruction,
  signV2Instruction,
  swigAddress,
  swigWalletAddress,
  type SwigAction,
} from "../../src/swig/program.js";
import { Chain, recordBytes } from "../chain.js";

/** Rent, key records and membership; no other program. */
const AUTHORITY_ACTIONS: readonly SwigAction[] = [
  { kind: "manageAuthority" },
  { kind: "program", program: SYSTEM_PROGRAM_ADDRESS },
  { kind: "program", program: RECORD_PROGRAM_ADDRESS },
  { kind: "solLimit", lamports: 1_000_000_000n },
];
/** System transfers within a SOL limit, but no Record writes. */
const MEMBER_ACTIONS: readonly SwigAction[] = [
  { kind: "program", program: SYSTEM_PROGRAM_ADDRESS },
  { kind: "solLimit", lamports: 10_000_000n },
];
const SOL = 1_000_000_000n;
// Swig authentication errors.
const MISSING_PERMISSION = /Custom\(3006\)/;
const SOL_LIMIT_EXCEEDED = /Custom\(3011\)/;
const CANNOT_MANAGE_AUTHORITY = /Custom\(3010\)/;
// Swig program error InvalidAuthorityNotFoundByRoleId.
const ROLE_NOT_FOUND = /Custom\(12\)/;

interface Swig {
  readonly address: Address;
  readonly wallet: Address;
}

async function createSwig(
  chain: Chain,
  payer: KeyPairSigner,
  authority: KeyPairSigner,
): Promise<Swig> {
  const id = Uint8Array.from(randomBytes(32));
  const swig = (await swigAddress(id)).address;
  const wallet = (await swigWalletAddress(swig)).address;
  await chain.send(payer, [
    await createSwigInstruction({
      payer,
      id,
      authority: authority.address,
      actions: AUTHORITY_ACTIONS,
    }),
  ]);
  chain.svm.airdrop(wallet, lamports(SOL));
  return { address: swig, wallet };
}

async function signV2(
  chain: Chain,
  swig: Swig,
  authority: KeyPairSigner,
  roleId: number,
  inner: readonly Instruction[],
): Promise<void> {
  await chain.send(authority, [
    await signV2Instruction({
      swig: swig.address,
      roleId,
      authority,
      inner,
    }),
  ]);
}

function transfer(from: Address, to: Address, amount: bigint): Instruction {
  return {
    programAddress: SYSTEM_PROGRAM_ADDRESS,
    accounts: [
      { address: from, role: AccountRole.WRITABLE_SIGNER },
      { address: to, role: AccountRole.WRITABLE },
    ],
    data: new ByteWriter().u32(2).u64(amount).finish(),
  };
}

describe("Swig wallets", () => {
  it("encodes actions with end offsets", () => {
    assert.deepEqual(
      encodeSwigActions([
        { kind: "manageAuthority" },
        { kind: "solLimit", lamports: 5n },
      ]),
      Uint8Array.of(
        ...[8, 0, 0, 0, 8, 0, 0, 0],
        ...[1, 0, 8, 0, 24, 0, 0, 0],
        ...[5, 0, 0, 0, 0, 0, 0, 0],
      ),
    );
  });

  it("creates a Swig whose root role is the view key authority", async () => {
    const chain = new Chain();
    const [payer, authority] = await Promise.all([
      chain.wallet(),
      chain.wallet(),
    ]);
    const swig = await createSwig(chain, payer, authority);
    const decoded = decodeSwig(chain.data(swig.address));
    assert.deepEqual(decoded.roles, [
      {
        id: 0,
        authorityType: 1,
        authority: authority.address,
        permissions: [
          SwigPermission.ManageAuthority,
          SwigPermission.Program,
          SwigPermission.Program,
          SwigPermission.SolLimit,
        ],
      },
    ]);
    const wallet = chain.svm.getAccount(swig.wallet);
    assert.ok(wallet.exists);
    assert.equal(wallet.programAddress, SYSTEM_PROGRAM_ADDRESS);
    assert.equal(wallet.data.length, 0);
  });

  it("publishes and replaces a record owned by the wallet address", async () => {
    const chain = new Chain();
    const [payer, authority] = await Promise.all([
      chain.wallet(),
      chain.wallet(),
    ]);
    const swig = await createSwig(chain, payer, authority);

    const first = recordBytes(1500, 1);
    const firstUpload = await prepareRecordUpload({
      owner: swig.wallet,
      payer,
      bytes: first,
    });
    await chain.upload(payer, firstUpload);
    await signV2(
      chain,
      swig,
      authority,
      0,
      await publishRecordInstructions({
        owner: swig.wallet,
        upload: firstUpload.address,
        predecessor: undefined,
        bytes: first,
      }),
    );
    assert.deepEqual(await fetchPublishedRecord(chain.rpc, swig.wallet), {
      address: firstUpload.address,
      bytes: first,
    });

    const second = recordBytes(900, 2);
    const secondUpload = await prepareRecordUpload({
      owner: swig.wallet,
      payer,
      bytes: second,
    });
    await chain.upload(payer, secondUpload);
    const walletBefore = chain.balance(swig.wallet);
    const firstRent = chain.balance(firstUpload.address);
    await signV2(
      chain,
      swig,
      authority,
      0,
      await publishRecordInstructions({
        owner: swig.wallet,
        upload: secondUpload.address,
        predecessor: firstUpload.address,
        bytes: second,
      }),
    );
    assert.deepEqual(await fetchPublishedRecord(chain.rpc, swig.wallet), {
      address: secondUpload.address,
      bytes: second,
    });
    assert.equal(chain.exists(firstUpload.address), false);
    assert.equal(chain.balance(swig.wallet), walletBefore + firstRent);
  });

  it("lets only the view key authority manage members, and members not publish", async () => {
    const chain = new Chain();
    const [payer, authority, member, outsider] = await Promise.all([
      chain.wallet(),
      chain.wallet(),
      chain.wallet(),
      chain.wallet(),
    ]);
    const swig = await createSwig(chain, payer, authority);
    await chain.send(payer, [
      addAuthorityInstruction({
        swig: swig.address,
        payer,
        authority,
        actingRoleId: 0,
        newAuthority: member.address,
        actions: MEMBER_ACTIONS,
      }),
    ]);
    const roles = decodeSwig(chain.data(swig.address)).roles;
    assert.deepEqual(
      roles.map((role) => [role.id, role.authority]),
      [
        [0, authority.address],
        [1, member.address],
      ],
    );

    // The member may move SOL within its limit, but not past it.
    const before = chain.balance(outsider.address);
    await signV2(chain, swig, member, 1, [
      transfer(swig.wallet, outsider.address, 1_000_000n),
    ]);
    assert.equal(chain.balance(outsider.address), before + 1_000_000n);
    await assert.rejects(
      signV2(chain, swig, member, 1, [
        transfer(swig.wallet, outsider.address, 20_000_000n),
      ]),
      SOL_LIMIT_EXCEEDED,
    );

    // Record has no permission on the member's role.
    const bytes = recordBytes(300);
    const upload = await prepareRecordUpload({
      owner: swig.wallet,
      payer,
      bytes,
    });
    await chain.upload(payer, upload);
    const publish = await publishRecordInstructions({
      owner: swig.wallet,
      upload: upload.address,
      predecessor: undefined,
      bytes,
    });
    await assert.rejects(
      signV2(chain, swig, member, 1, publish),
      MISSING_PERMISSION,
    );
    assert.equal(await fetchPublishedRecord(chain.rpc, swig.wallet), undefined);

    // A member cannot add or remove authorities.
    await assert.rejects(
      chain.send(payer, [
        addAuthorityInstruction({
          swig: swig.address,
          payer,
          authority: member,
          actingRoleId: 1,
          newAuthority: outsider.address,
          actions: MEMBER_ACTIONS,
        }),
      ]),
      CANNOT_MANAGE_AUTHORITY,
    );

    await signV2(chain, swig, authority, 0, publish);
    assert.equal(
      (await fetchPublishedRecord(chain.rpc, swig.wallet))?.address,
      upload.address,
    );

    await chain.send(payer, [
      removeAuthorityInstruction({
        swig: swig.address,
        payer,
        authority,
        actingRoleId: 0,
        roleId: 1,
      }),
    ]);
    assert.deepEqual(
      decodeSwig(chain.data(swig.address)).roles.map((role) => role.id),
      [0],
    );
    await assert.rejects(
      signV2(chain, swig, member, 1, [
        transfer(swig.wallet, outsider.address, 1_000n),
      ]),
      ROLE_NOT_FOUND,
    );
  });
});
