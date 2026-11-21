import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AccountRole,
  address,
  generateKeyPairSigner,
  type Address,
} from "@solana/kit";

import {
  checkSynchronousConsensus,
  compileSyncPayload,
  decodeSettings,
  ALL_PERMISSIONS,
  SmartAccountPermission,
  rotationActions,
  type Settings,
} from "../../helpers/smart-account/program.js";

async function keys(count: number): Promise<Address[]> {
  return Promise.all(
    Array.from(
      { length: count },
      async () => (await generateKeyPairSigner()).address,
    ),
  );
}

const AUTONOMOUS = address("11111111111111111111111111111111");

function settingsWith(
  signers: Settings["signers"],
  threshold: number,
): Settings {
  return {
    settingsAuthority: AUTONOMOUS,
    threshold,
    timeLock: 0,
    signers,
  };
}

describe("squads", () => {
  it("orders rotation actions add, change threshold, remove", async () => {
    const [a, b, c, d] = await keys(4);
    const current = settingsWith(
      [a!, b!, c!].map((key) => ({ key, permissions: ALL_PERMISSIONS })),
      3,
    );
    const actions = rotationActions(
      current,
      [{ key: d!, permissions: ALL_PERMISSIONS }],
      1,
    );
    assert.deepEqual(
      actions.map((action) => action.kind),
      [
        "addSigner",
        "changeThreshold",
        "removeSigner",
        "removeSigner",
        "removeSigner",
      ],
    );
  });

  it("leaves the threshold alone when it does not change", async () => {
    const [a, b] = await keys(2);
    const current = settingsWith(
      [{ key: a!, permissions: ALL_PERMISSIONS }],
      1,
    );
    const actions = rotationActions(
      current,
      [
        { key: a!, permissions: ALL_PERMISSIONS },
        { key: b!, permissions: ALL_PERMISSIONS },
      ],
      1,
    );
    assert.deepEqual(actions, [
      {
        kind: "addSigner",
        newSigner: { key: b!, permissions: ALL_PERMISSIONS },
      },
    ]);
  });

  it("checks Squads' sync consensus", async () => {
    const [a, b, c] = await keys(3);
    const settings = settingsWith(
      [
        {
          key: a!,
          permissions:
            SmartAccountPermission.Initiate | SmartAccountPermission.Vote,
        },
        {
          key: b!,
          permissions:
            SmartAccountPermission.Vote | SmartAccountPermission.Execute,
        },
        { key: c!, permissions: SmartAccountPermission.Vote },
      ],
      2,
    );
    assert.doesNotThrow(() => checkSynchronousConsensus(settings, [a!, b!]));
    assert.throws(
      () => checkSynchronousConsensus(settings, [a!, c!]),
      /initiate, vote and execute/,
    );
    assert.throws(
      () => checkSynchronousConsensus(settings, [b!]),
      /initiate, vote and execute/,
    );
    assert.throws(
      () => checkSynchronousConsensus(settings, [a!, a!]),
      /duplicate/,
    );
  });

  it("needs threshold voters even when the permissions are covered", async () => {
    const [a, b] = await keys(2);
    const settings = settingsWith(
      [
        { key: a!, permissions: ALL_PERMISSIONS },
        { key: b!, permissions: SmartAccountPermission.Vote },
      ],
      2,
    );
    assert.doesNotThrow(() => checkSynchronousConsensus(settings, [a!, b!]));
    assert.throws(
      () => checkSynchronousConsensus(settings, [a!]),
      /need 2 voting approvers, got 1/,
    );
  });

  it("refuses a time lock or a settings authority", async () => {
    const [a] = await keys(1);
    const settings = settingsWith(
      [{ key: a!, permissions: ALL_PERMISSIONS }],
      1,
    );
    assert.doesNotThrow(() => checkSynchronousConsensus(settings, [a!]));
    assert.throws(
      () => checkSynchronousConsensus({ ...settings, timeLock: 60 }, [a!]),
      /time_lock 0/,
    );
    assert.throws(
      () =>
        checkSynchronousConsensus({ ...settings, settingsAuthority: a! }, [a!]),
      /settings authority/,
    );
  });

  it("compiles the vault first and drops its signer flag", async () => {
    const [vault, program, other] = await keys(3);
    const { payload, accounts } = compileSyncPayload(
      [
        {
          programAddress: program!,
          accounts: [
            { address: other!, role: AccountRole.WRITABLE },
            { address: vault!, role: AccountRole.READONLY_SIGNER },
          ],
          data: Uint8Array.of(9, 8),
        },
      ],
      vault!,
    );
    assert.deepEqual(
      accounts.map(({ address, role }) => ({ address, role })),
      [
        { address: vault!, role: AccountRole.WRITABLE },
        { address: program!, role: AccountRole.READONLY },
        { address: other!, role: AccountRole.WRITABLE },
      ],
    );
    // count, program index, account count, account indexes, u16 data length, data
    assert.deepEqual([...payload], [1, 1, 2, 2, 0, 2, 0, 9, 8]);
  });

  it("compiles at most 256 accounts, the reach of a u8 index", async () => {
    const [vault, program] = await keys(2);
    const compile = async (count: number) => {
      const others = await keys(count);
      return compileSyncPayload(
        [
          {
            programAddress: program!,
            accounts: others.map((address) => ({
              address,
              role: AccountRole.READONLY,
            })),
          },
        ],
        vault!,
      );
    };
    // The vault and the program take two of the 256 slots.
    assert.equal((await compile(254)).accounts.length, 256);
    await assert.rejects(compile(255), /more than 256 accounts/);
  });

  it("rejects an account that is not Settings", () => {
    assert.throws(
      () => decodeSettings(new Uint8Array(200)),
      /not a Squads Settings account/,
    );
  });
});
