/** Reads a wallet program's account for the helpers' decoders. */
import type { Address } from "@solana/kit";
import type { SprClient } from "@heliuslabs/spr/client";

/** The account's data at `confirmed`, or undefined if it does not exist. */
export async function accountData(
  client: SprClient,
  account: Address,
): Promise<Uint8Array | undefined> {
  const { value } = await client.solanaRpc
    .getAccountInfo(account, { encoding: "base64", commitment: "confirmed" })
    .send();
  if (value === null) return undefined;
  return new Uint8Array(Buffer.from(value.data[0], "base64"));
}
